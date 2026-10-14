// Ciclo de vida das sessões: máquina de estados + reserva exclusiva.
//
// Implementa o ciclo obrigatório (docs/SECURITY.md):
//  1 validar usuário  2 reservar exclusiva  3 criar ambiente isolado
//  4 expor biblioteca  5 confirmar streaming pronto  7 detectar fim
//  8 encerrar processos  9 revogar acessos  10 descartar  11 verificar
//  12 liberar SOMENTE após verificação.
//
// A reserva é atômica: um único slot na tabela machine (id=1). Se houver
// qualquer sessão aberta, nova reserva é recusada. Se a limpeza falhar, a
// máquina fica 'locked' e não libera até recuperação administrativa.
import * as db from './db.js';
import * as sunshine from './sunshine.js';
import {
  createSessionEnvironment,
  discardSessionEnvironment,
  verifyCleanup,
  exposeLibraryReadonly,
  IsolationError,
} from './isolation.js';
import { loadConfig } from './config.js';

export class SessionError extends Error {
  constructor(message, status = 409, code = 'SESSION') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const OPEN_STATES = ['reserved', 'preparing', 'active', 'ending', 'cleaning'];

// Passo 2: reserva exclusiva da máquina. Retorna a sessão criada ou lança.
// `mode` vem da permissão gravada no token ('game' isolado | 'full' PC completo),
// nunca de entrada livre do cliente: o servidor decide.
export function reserveSession(user, tokenId, mode = 'game') {
  const machine = db.getMachine();
  if (machine.state === 'locked') {
    throw new SessionError(
      'A máquina está bloqueada por uma limpeza incompleta. Recuperação administrativa necessária.',
      423,
      'LOCKED'
    );
  }
  if (['preparing', 'in-use', 'cleaning'].includes(machine.state)) {
    // Se a sessão aberta pertence ao MESMO usuário, é reconexão (permitida).
    const mineReconnect = db.openSessionFor(user.id);
    if (!mineReconnect || mineReconnect.user_id !== user.id) {
      throw new SessionError('A máquina está ocupada. Tente mais tarde.', 409, 'BUSY');
    }
  }
  // Reconexão: retorna a sessão existente do MESMO usuário, sem duplicar.
  const mine = db.openSessionFor(user.id);
  if (mine) {
    return { session: db.getSession(mine.id), resumed: true };
  }
  // Qualquer outra sessão aberta (de outro usuário) impede nova reserva.
  const open = db.anyOpenSession();
  if (open) {
    throw new SessionError('Já existe uma sessão aberta.', 409, 'SESSION_OPEN');
  }
  const sessionId = db.createSession({
    userId: user.id,
    tokenId,
    mode: mode === 'full' ? 'full' : 'game',
  });
  db.setMachineState('preparing', 'preparando ambiente', sessionId);
  db.logEvent('info', 'sessão reservada', { sessionId, userId: user.id, mode });
  return { session: db.getSession(sessionId), resumed: false };
}

// Passos 3-4-5: cria ambiente, expõe biblioteca e prepara o streaming.
export async function prepareSession(sessionId) {
  const cfg = loadConfig();
  let session = db.getSession(sessionId);
  if (!session) throw new SessionError('Sessão inexistente.', 404, 'NOT_FOUND');
  const mode = session.mode === 'full' ? 'full' : 'game';
  db.updateSession(sessionId, { state: 'preparing' });
  db.setMachineState(
    'preparing',
    mode === 'full' ? 'preparando PC completo' : 'criando ambiente isolado',
    sessionId
  );

  let env;
  let lib = { exposed: false, reason: 'modo PC completo: sem biblioteca isolada' };
  if (mode === 'full') {
    // Modo PC completo: o jogador controla o desktop do dono — é o objetivo,
    // então NÃO há isolamento de SO aqui (diferente do modo 'game'). A sessão
    // continua rastreada e o streaming é confirmado antes de ativar.
    env = { runtimeDir: null, unixUser: null, home: null, isolated: false, mode: 'full' };
    db.logEvent('warn', 'sessão em modo PC completo (sem isolamento de SO)', {
      sessionId,
      userId: session.user_id,
    });
  } else {
    try {
      env = await createSessionEnvironment(sessionId);
    } catch (e) {
      await failSession(sessionId, `falha ao criar ambiente: ${e.message}`);
      throw new SessionError(`Falha ao preparar o ambiente: ${e.message}`, 500, 'ENV');
    }
    db.updateSession(sessionId, {
      runtimeDir: env.runtimeDir,
      unixUser: env.unixUser,
    });
    lib = exposeLibraryReadonly(env, cfg.gameLibraryDir);
    db.logEvent('info', 'biblioteca exposta', { sessionId, ...lib });
  }

  // Passo 5: streaming é iniciado pelo Moonlight real conectando no Sunshine.
  // Aqui confirmamos que o Sunshine está alcançável antes de marcar a sessão
  // como ativa. Se o Sunshine não responder, a sessão falha e limpa.
  const info = await sunshine.readServerInfo();
  if (!info.reachable) {
    await cleanupSession(sessionId, { reason: 'sunshine indisponível' });
    throw new SessionError(
      'O servidor de streaming (Sunshine) não respondeu. A sessão foi cancelada.',
      503,
      'SUNSHINE_DOWN'
    );
  }

  db.updateSession(sessionId, { state: 'active' });
  db.setMachineState('in-use', 'sessão ativa', sessionId);
  db.logEvent('info', 'sessão ativa', { sessionId, userId: session.user_id, mode });
  return {
    session: db.getSession(sessionId),
    streamTarget: cfg.sunshineAddress,
    mode,
    library: lib,
    isolation: { mode: env.mode, unixUser: env.unixUser, isolated: env.isolated },
  };
}

// Passo 7-8-9-10-11-12: encerramento com descarte e verificação.
export async function cleanupSession(sessionId, { reason = '' } = {}) {
  const session = db.getSession(sessionId);
  if (!session) throw new SessionError('Sessão inexistente.', 404, 'NOT_FOUND');
  db.updateSession(sessionId, { state: 'cleaning' });
  db.setMachineState('cleaning', 'encerrando e limpando', sessionId);
  db.logEvent('info', 'iniciando limpeza', { sessionId, reason });

  // Passo 8/9: encerra app no Sunshine (revoga stream) e processos do usuário.
  await sunshine.closeRunningApp();

  const env = {
    runtimeDir: session.runtime_dir,
    unixUser: session.unix_user,
  };

  // Passo 10: descarta dados temporários.
  let discard;
  try {
    discard = await discardSessionEnvironment(env);
  } catch (e) {
    await failSession(sessionId, `descarte recusado: ${e.message}`);
    throw new SessionError(`Limpeza falhou: ${e.message}`, 500, 'CLEANUP');
  }

  // Passo 11: verifica limpeza.
  const verification = await verifyCleanup(env);
  if (!discard.ok || !verification.clean) {
    const notes = [...discard.errors, ...verification.problems].join('; ');
    await failSession(sessionId, notes);
    throw new SessionError(
      `Limpeza incompleta: ${notes}. Máquina bloqueada para recuperação.`,
      500,
      'CLEANUP_INCOMPLETE'
    );
  }

  // Passo 12: libera a máquina somente após verificação OK.
  db.updateSession(sessionId, {
    state: 'closed',
    endedAt: db.now(),
    cleanupOk: 1,
    cleanupNotes: reason || null,
  });
  // Revoga token da sessão (passo 9).
  if (session.token_id) db.revokeToken(session.token_id);
  db.setMachineState('available', 'livre', null);
  db.logEvent('info', 'sessão encerrada e limpa', { sessionId });
  return { ok: true };
}

// Falha de sessão: mantém a máquina BLOQUEADA (não libera) quando a limpeza
// incompleta pode ter deixado dados/processos para trás.
async function failSession(sessionId, notes) {
  const session = db.getSession(sessionId);
  const machine = db.getMachine();
  // Se a falha é de limpeza (há runtime_dir com dados), trava; senão libera.
  const needsLock =
    session?.runtime_dir && /limpeza|descarte|cleanup|incompleto/i.test(notes);
  db.updateSession(sessionId, {
    state: 'failed',
    endedAt: db.now(),
    cleanupOk: 0,
    cleanupNotes: notes,
  });
  if (needsLock) {
    db.setMachineState('locked', `limpeza incompleta: ${notes}`, sessionId);
    db.logEvent('error', 'máquina travada por limpeza incompleta', { sessionId, notes });
  } else {
    db.setMachineState('error', notes, null);
    db.logEvent('error', 'sessão falhou', { sessionId, notes });
  }
}

// Passo 7: detecção de fim de sessão. Compara o estado real do Sunshine com a
// nossa sessão. Se o Sunshine voltou a 'FREE' com nossa sessão 'active', o
// jogador saiu; encerramos e limpamos.
export async function pollActiveSession() {
  const machine = db.getMachine();
  if (machine.state !== 'in-use' || !machine.session_id) return null;
  const session = db.getSession(machine.session_id);
  if (!session || session.state !== 'active') return null;

  const info = await sunshine.readServerInfo();
  if (info.reachable && !info.busy) {
    // Streaming parou (jogador fechou Moonlight ou saiu do jogo).
    await cleanupSession(machine.session_id, { reason: 'streaming encerrado' });
    return { ended: true, sessionId: machine.session_id };
  }
  return { ended: false, sessionId: machine.session_id, sunshine: info };
}

// Recuperação administrativa de uma máquina travada. Só libera quando o
// operador confirma que verificou manualmente.
export function adminForceUnlock({ operator = 'admin' } = {}) {
  const machine = db.getMachine();
  if (machine.state !== 'locked' && machine.state !== 'error') {
    throw new SessionError('A máquina não está travada.', 400, 'NOT_LOCKED');
  }
  // Fecha sessões abertas como falha e libera.
  const open = db.anyOpenSession();
  if (open) {
    db.updateSession(open.id, {
      state: 'failed',
      endedAt: db.now(),
      cleanupNotes: 'liberado administrativamente',
    });
  }
  db.setMachineState('available', `liberado por ${operator}`, null);
  db.logEvent('warn', 'liberação administrativa', { operator, priorState: machine.state });
  return { ok: true, priorState: machine.state };
}

export { OPEN_STATES };
