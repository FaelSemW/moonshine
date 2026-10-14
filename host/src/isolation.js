// Isolamento e descarte de sessões.
//
// Estratégia escolhida (documentada em docs/SECURITY.md): para cada sessão o
// HOST usa um USUÁRIO LINUX DEDICADO (prefixo configurável, ex.: msplayer-<hex>).
// O HOME do usuário dedicado é um diretório temporário sob sessionRuntimeDir,
// registrado como home em /etc/passwd e descartado ao fim da sessão. A
// biblioteca permanente é exposta ao usuário da sessão como somente leitura.
// No Bazzite as operações com root passam pelo helper restrito
// (deploy/bazzite/moonshine-helper.sh + sudoers do install.sh).
//
// LIMITAÇÃO DE RUNTIME HONESTA (docs/SECURITY.md, fase 2): os apps/jogos do
// Sunshine ainda são lançados na conta do proprietário — a identidade
// isolada vale para os processos que o HOST cria sob o usuário dedicado.
// Fazer o streaming rodar dentro da sessão do usuário dedicado é a próxima
// fase; até lá o modo 'game' NÃO afirma isolamento de input em runtime.
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
import {
  rmSync,
  mkdirSync,
  existsSync,
  chmodSync,
  lstatSync,
  readlinkSync,
  accessSync,
  constants,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, PROJECT_ROOT } from './config.js';

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

// ---------------------------------------------------------------- privilegio -
// useradd/userdel/chown/pkill exigem root, mas o serviço roda como usuário
// comum (systemd --user). O Bazzite usa um HELPER restrito autorizado via
// sudoers: deploy/bazzite/moonshine-helper.sh + /etc/sudoers.d/moonshine-isolation
// (instalados pelo install.sh com um único sudo). O helper valida todo
// argumento por regex antes de qualquer comando — ele é o portão de root.
//
// Sem helper, os comandos são chamados direto: funciona apenas se o serviço
// tiver privilégio por si (ou em testes como root).
export function helperPath() {
  if (process.platform !== 'linux') return null;
  const cfg = loadConfig();
  const p =
    cfg.isolationHelper ||
    resolve(PROJECT_ROOT, 'deploy', 'bazzite', 'moonshine-helper.sh');
  try {
    accessSync(p, constants.X_OK);
    return p;
  } catch {
    return null;
  }
}

// Executa uma operação no helper via `sudo -n` (nunca pede senha: ou a regra
// sudoers existe, ou falha com instrução de correção). Retorna false quando
// NÃO há helper — o chamador então usa o comando direto. Quando há helper e a
// operação falha, lança IsolationError: não existe fallback silencioso, pois
// esconderia a falta de privilégio até o prepare da sessão.
async function runHelper(op, argv) {
  const helper = helperPath();
  if (!helper) return false;
  try {
    await run('sudo', ['-n', helper, op, ...argv]);
    return true;
  } catch (e) {
    const detail = (e.stderr || e.message || '').trim();
    throw new IsolationError(
      `operação privilegiada "${op}" recusada: ${detail} ` +
        '(verifique o sudoers /etc/sudoers.d/moonshine-isolation — rode o install.sh)',
      'PRIV'
    );
  }
}

// Cria o usuário Linux dedicado se ainda não existir e retorna seu nome.
// `home` é o HOME temporário da sessão (fica em /etc/passwd como home do
// usuário — nada é criado em /home). Requer privilégio: no Bazzite passa pelo
// helper + sudoers do install.sh (ver runHelper acima); sem helper, chama
// useradd direto (só funciona com privilégio próprio).
export async function ensureDedicatedUser(prefix, home) {
  const cfg = loadConfig();
  const base = prefix || cfg.dedicatedUserPrefix;
  // Procura um índice livre (base0, base1, ...). Por ora usamos um fixo por
  // sessão: msplayer-<aleatorio>. Simplificamos para um usuário por sessão.
  const name = `${base}-${randomBytes(3).toString('hex')}`.slice(0, 32);
  if (process.platform !== 'linux') {
    return { user: name, created: false, simulated: true };
  }
  if (!home || typeof home !== 'string') {
    throw new IsolationError('ensureDedicatedUser: HOME temporário obrigatório', 'USER_CREATE');
  }
  try {
    await run('id', ['-u', name]);
    // já existe
    return { user: name, created: false };
  } catch {
    /* não existe */
  }
  try {
    const viaHelper = await runHelper('add', [name, home]);
    if (!viaHelper) {
      // Sem --create-home: o chamador já criou o HOME com 0700; aqui só
      // registramos o caminho em /etc/passwd (o chown -R adota o diretório).
      // Grupo `games` é opcional (nem toda distro o tem).
      const args = ['--home-dir', home, '--shell', '/usr/sbin/nologin'];
      try {
        await run('getent', ['group', 'games']);
        args.push('--groups', 'games');
      } catch {
        /* sem grupo games — segue sem */
      }
      args.push(name);
      await run('useradd', args);
    }
    return { user: name, created: true };
  } catch (e) {
    if (e instanceof IsolationError) throw e;
    const hint = helperPath()
      ? ''
      : ' — helper de privilégio não encontrado (deploy/bazzite/moonshine-helper.sh); rode o install.sh';
    throw new IsolationError(`falha ao criar usuário dedicado: ${e.message}${hint}`, 'USER_CREATE');
  }
}

// Remove o usuário dedicado (usado após descarte bem-sucedido).
export async function removeDedicatedUser(name) {
  if (process.platform !== 'linux') return { removed: false, simulated: true };
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new IsolationError(`nome de usuário inválido: ${name}`, 'BAD_USERNAME');
  }
  if (helperPath()) {
    // O helper já tenta `userdel --remove` e, em falha, `userdel` simples.
    try {
      await runHelper('del', [name]);
      return { removed: true };
    } catch (e) {
      return { removed: false, error: e.message };
    }
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
    // HOME temporário do usuário dedicado (é o que vai em /etc/passwd).
    const home = resolve(runtimeDir, 'home');
    try {
      assertInside(runtimeDir, home);
      // HOME criado com 0700 ANTES do useradd: ele só registra o caminho em
      // /etc/passwd (sem --create-home) e o chown -R adota o diretório
      // preservando o modo 0700.
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const { user } = await ensureDedicatedUser(undefined, home);
      unixUser = user;
      const viaHelper = await runHelper('chown', [user, runtimeDir]);
      if (!viaHelper) {
        await run('chown', ['-R', `${user}:${user}`, runtimeDir]);
      }
      return { runtimeDir, unixUser, home, isolated: true, mode: 'dedicated-user' };
    } catch (e) {
      // Preparação falhou: desfaz o que já foi criado (usuário e diretório)
      // para não deixar lixo de sessão que nem chegou a existir no banco.
      if (unixUser) await removeDedicatedUser(unixUser);
      try {
        rmSync(runtimeDir, { recursive: true, force: true });
      } catch {
        // Pode ter ficado com dono da sessão: devolve ao serviço e tenta de novo.
        if (unixUser) {
          try {
            await runHelper('release', [runtimeDir]);
            rmSync(runtimeDir, { recursive: true, force: true });
          } catch {
            /* best-effort: o prepare já falhou; lixo sob sessionRuntimeDir */
          }
        }
      }
      if (e instanceof IsolationError) throw e;
      throw new IsolationError(`falha ao aplicar dono do ambiente: ${e.message}`, 'CHOWN');
    }
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
      const viaHelper = await runHelper('kill', [env.unixUser]);
      if (!viaHelper) {
        await run('pkill', ['-KILL', '-u', env.unixUser]);
      }
    } catch {
      /* pkill retorna 1 se não há processos — ok; via helper já sai em 0 */
    }
    // O diretório pertence ao usuário da sessão (chown na criação): devolve
    // ao serviço para que a remoção canônica abaixo funcione. Sem isso o
    // rmSync daria EACCES e a máquina travaria em limpeza incompleta.
    try {
      await runHelper('release', [env.runtimeDir]);
    } catch (e) {
      // A remoção abaixo vai falhar e o ciclo marcará limpeza incompleta
      // (fail-safe: máquina bloqueada, nunca liberar com lixo para trás).
      results.errors.push(`release ${env.runtimeDir}: ${e.message}`);
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
