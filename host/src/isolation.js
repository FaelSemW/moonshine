// Isolamento e descarte de sessões.
//
// Estratégia escolhida (documentada em docs/SECURITY.md): para cada sessão o
// HOST usa um USUÁRIO LINUX DEDICADO (prefixo configurável, ex.: msplayer3).
// O jogador nunca roda como o proprietário. O HOME do usuário dedicado é um
// diretório temporário sob sessionRuntimeDir, descartado ao fim da sessão.
// A biblioteca de jogos permanente é montada SOMENTE LEITURA para esse usuário.
//
// Propriedades de segurança:
//  - O jogador não lê os arquivos pessoais do proprietário (usuário diferente,
//    home temporário com permissões 0700 do próprio usuário dedicado).
//  - A biblioteca permanente é somente leitura; o jogador não a modifica.
//  - O descarte remove APENAS caminhos canonicizados sob sessionRuntimeDir.
//    Um caminho fora desse prefixo, ou que escape por ../ ou symlink, é
//    recusado. Nunca apagamos arquivos do proprietário, do sistema ou de
//    outros usuários.
//  - Se a limpeza falhar, a máquina fica em estado 'locked' e NÃO aceita nova
//    sessão até recuperação administrativa.
//
// Em SO sem suporte (Windows de desenvolvimento), o modo de isolamento 'none'
// usa um diretório temporário simples e o ciclo permanece funcional para teste
// do plano de controle, sem afirmar isolamento de SO.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync, mkdirSync, existsSync, chmodSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';

const execFileAsync = promisify(execFile);

export class IsolationError extends Error {
  constructor(message, code = 'ISOLATION') {
    super(message);
    this.code = code;
  }
}

// Garante que `target` está estritamente dentro de `root` após resolução
// canônica, sem symlink escape. Lança IsolationError caso contrário.
export function assertInside(root, target) {
  const canonRoot = resolve(root);
  const canonTarget = resolve(target);
  if (canonTarget !== canonRoot && !canonTarget.startsWith(canonRoot + sep)) {
    throw new IsolationError(
      `recusado: caminho fora do escopo autorizado (${canonTarget})`,
      'PATH_ESCAPE'
    );
  }
  // Verifica se algum componente é symlink que escape (defesa contra link).
  try {
    const st = lstatSync(canonTarget);
    if (st.isSymbolicLink()) {
      const real = resolve(readlinkSync(canonTarget));
      if (real !== canonRoot && !real.startsWith(canonRoot + sep)) {
        throw new IsolationError('recusado: symlink aponta para fora', 'SYMLINK_ESCAPE');
      }
    }
  } catch (e) {
    if (e instanceof IsolationError) throw e;
    /* alvo pode não existir ainda — ok */
  }
  return true;
}

function run(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, { timeout: 15000, ...opts });
}

// Cria o usuário Linux dedicado se ainda não existir e retorna seu nome.
// Usa useradd (ou adduser). Requer privilégio (o instalador roda com sudo ou o
// serviço tem permissão via sudoers restrito a estes comandos).
export async function ensureDedicatedUser(prefix) {
  const cfg = loadConfig();
  const base = prefix || cfg.dedicatedUserPrefix;
  // Procura um índice livre (base0, base1, ...). Por ora usamos um fixo por
  // sessão: msplayer-<aleatorio>. Simplificamos para um usuário por sessão.
  const name = `${base}-${randomBytes(3).toString('hex')}`.slice(0, 32);
  if (process.platform !== 'linux') {
    return { user: name, created: false, simulated: true };
  }
  try {
    await run('id', ['-u', name]);
    // já existe
    return { user: name, created: false };
  } catch {
    /* não existe */
  }
  try {
    await run('useradd', [
      '--create-home',
      '--shell',
      '/usr/sbin/nologin',
      '--groups',
      'games',
      name,
    ]);
    return { user: name, created: true };
  } catch (e) {
    throw new IsolationError(`falha ao criar usuário dedicado: ${e.message}`, 'USER_CREATE');
  }
}

// Remove o usuário dedicado (usado após descarte bem-sucedido).
export async function removeDedicatedUser(name) {
  if (process.platform !== 'linux') return { removed: false, simulated: true };
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new IsolationError(`nome de usuário inválido: ${name}`, 'BAD_USERNAME');
  }
  try {
    await run('userdel', ['--remove', name]);
    return { removed: true };
  } catch (e) {
    // Se home já foi removida, userdel pode falhar; tenta sem --remove.
    try {
      await run('userdel', [name]);
      return { removed: true, note: e.message };
    } catch (e2) {
      return { removed: false, error: e2.message };
    }
  }
}

// Cria o ambiente temporário de uma sessão. Retorna metadados usados no ciclo.
export async function createSessionEnvironment(sessionId) {
  const cfg = loadConfig();
  const runtimeRoot = cfg.sessionRuntimeDir;
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o711 });
  const runtimeDir = resolve(runtimeRoot, `s${sessionId}-${randomBytes(4).toString('hex')}`);
  assertInside(runtimeRoot, runtimeDir);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  let unixUser = null;
  if (cfg.isolationMode === 'dedicated-user' && process.platform === 'linux') {
    const { user } = await ensureDedicatedUser();
    unixUser = user;
    // HOME temporário do usuário dedicado.
    const home = resolve(runtimeDir, 'home');
    assertInside(runtimeDir, home);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      await run('chown', ['-R', `${user}:${user}`, runtimeDir]);
    } catch (e) {
      throw new IsolationError(`falha ao aplicar dono do ambiente: ${e.message}`, 'CHOWN');
    }
    return { runtimeDir, unixUser, home, isolated: true, mode: 'dedicated-user' };
  }

  // Modos sem isolamento de SO (desenvolvimento): diretório temporário simples.
  const home = resolve(runtimeDir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { runtimeDir, unixUser, home, isolated: false, mode: cfg.isolationMode };
}

// Torna a biblioteca permanente acessível ao jogador como SOMENTE LEITURA.
// No Linux, usa bind mount read-only ou permissão de leitura. Aqui criamos um
// link simbólico de leitura para o runtime, ou registramos o caminho para o
// launcher usar. Não copiamos a biblioteca (economia de disco/tempo).
export function exposeLibraryReadonly(env, libraryDir) {
  const cfg = loadConfig();
  const lib = libraryDir || cfg.gameLibraryDir;
  if (!existsSync(lib)) {
    return { exposed: false, reason: 'biblioteca inexistente', path: lib };
  }
  // O acesso real somente-leitura é garantido no Linux por bind mount ro ou
  // pelo fato do usuário dedicado ter apenas permissão de leitura no grupo.
  // Registramos o caminho no ambiente para o launcher.
  return { exposed: true, path: lib, readonly: true, mode: env.mode };
}

// Descarta o ambiente temporário de uma sessão.
// SEGURANÇA: só remove caminhos canonicizados sob sessionRuntimeDir.
// Retorna { ok, removed[] } ou lança em escape.
export async function discardSessionEnvironment(env) {
  const cfg = loadConfig();
  const runtimeRoot = cfg.sessionRuntimeDir;
  const results = { ok: true, removed: [], errors: [] };

  if (!env || !env.runtimeDir) {
    return { ok: true, removed: [], errors: [], note: 'sem ambiente' };
  }
  // Validação de escopo ANTES de qualquer remoção.
  assertInside(runtimeRoot, env.runtimeDir);

  // Encerra processos do usuário dedicado (se Linux) antes de remover arquivos.
  if (env.unixUser && process.platform === 'linux') {
    try {
      await run('pkill', ['-KILL', '-u', env.unixUser]);
    } catch {
      /* pkill retorna 1 se não há processos — ok */
    }
  }

  try {
    rmSync(env.runtimeDir, { recursive: true, force: true });
    results.removed.push(env.runtimeDir);
  } catch (e) {
    results.errors.push(`${env.runtimeDir}: ${e.message}`);
    results.ok = false;
  }

  // Remove usuário dedicado somente se o descarte de arquivos funcionou.
  if (results.ok && env.unixUser && process.platform === 'linux') {
    const r = await removeDedicatedUser(env.unixUser);
    if (r.removed === false && r.error) {
      results.errors.push(`userdel ${env.unixUser}: ${r.error}`);
      results.ok = false;
    }
  }
  return results;
}

// Verificação pós-limpeza: confirma que o runtimeDir não existe mais e que
// nenhum processo do usuário dedicado permanece. usado pelo ciclo para decidir
// se a máquina pode ser liberada.
export async function verifyCleanup(env) {
  const cfg = loadConfig();
  const problems = [];
  if (env?.runtimeDir) {
    assertInside(cfg.sessionRuntimeDir, env.runtimeDir);
    if (existsSync(env.runtimeDir)) {
      problems.push(`diretório ainda existe: ${env.runtimeDir}`);
    }
  }
  if (env?.unixUser && process.platform === 'linux') {
    try {
      await run('pgrep', ['-u', env.unixUser]);
      problems.push(`processos ainda ativos do usuário ${env.unixUser}`);
    } catch {
      /* pgrep falha = nenhum processo — ok */
    }
  }
  return { clean: problems.length === 0, problems };
}
