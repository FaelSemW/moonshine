// Testes do helper privilegiado de isolamento
// (deploy/bazzite/moonshine-helper.sh).
//
// O helper é o portão de root do modo de jogo dedicado: valida TODA entrada
// por regex antes de qualquer comando. Aqui cobrimos:
//  1 resolução do helper em isolation.js (todas as plataformas);
//  2 recusa de entradas inválidas (bash, sem sudo — roda até no Windows com
//    Git Bash; pula se não houver bash);
//  3 ciclo real no Linux com sudo sem senha (CI): usuário dedicado criado via
//    isolation.createSessionEnvironment → chown → descarte → userdel →
//    verifyCleanup limpo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { freshDataDir, cleanupDataDir } from './helpers.js';

const execFileAsync = promisify(execFile);

// Ordem importa: o env precisa estar antes do import dinâmico (config.js
// congela os DEFAULT_CONFIG na avaliação do módulo).
const dir = freshDataDir();
process.env.MOONSHINE_ISOLATION = 'dedicated-user'; // este arquivo testa o helper
process.env.MOONSHINE_SESSION_RUNTIME = '/var/tmp/moonshine-sessions'; // o helper só aceita este root
const isolation = await import('../host/src/isolation.js');
const { PROJECT_ROOT } = await import('../host/src/config.js');

test.after(() => cleanupDataDir(dir));

const LINUX = process.platform === 'linux';
const HELPER = join(PROJECT_ROOT, 'deploy', 'bazzite', 'moonshine-helper.sh');

// Roda o helper SEM sudo (só validação — nos casos inválidos ele recusa antes
// de qualquer comando privilegiado). Retorna { code, out }.
async function helper(args, { sudo = false, env = null } = {}) {
  const cmd = sudo ? 'sudo' : 'bash';
  const argv = sudo ? ['-n', HELPER, ...args] : [HELPER, ...args];
  try {
    const r = await execFileAsync(cmd, argv, {
      timeout: 20000,
      ...(env ? { env } : {}),
    });
    return { code: 0, out: `${r.stdout}${r.stderr}` };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// bash disponível? (Linux sempre; Windows só com Git Bash)
let BASH_OK = false;
try {
  await execFileAsync('bash', ['-c', 'exit 0'], { timeout: 5000 });
  BASH_OK = true;
} catch {
  BASH_OK = false;
}

// sudo sem senha disponível? (GitHub Actions tem; desktop Linux pode não ter)
let SUDO_OK = false;
if (LINUX) {
  try {
    await execFileAsync('sudo', ['-n', 'true'], { timeout: 5000 });
    SUDO_OK = true;
  } catch {
    SUDO_OK = false;
  }
}

test('helperPath: resolve o helper no Linux e ignora fora do Linux', () => {
  if (LINUX) {
    const p = isolation.helperPath();
    assert.ok(p, 'no Linux o helper do repositório deve ser encontrado');
    assert.equal(p, HELPER);
    assert.ok(existsSync(p));
  } else {
    assert.equal(isolation.helperPath(), null, 'fora do Linux não há helper');
  }
});

test('helper recusa toda entrada inválida (exit 64, sem executar nada)', {
  skip: BASH_OK ? false : 'bash indisponível neste sistema',
}, async () => {
  // Sem argumentos.
  let r = await helper([]);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /uso:/);

  // Operação desconhecida.
  r = await helper(['frobnicate', 'msplayer-123abc']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /operação desconhecida/);

  // add: argc errado.
  r = await helper(['add', 'msplayer-123abc']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /add: espera/);

  // add: nomes fora do padrão (nada de root, uppercase, non-hex ou traversal).
  const validDir = '/var/tmp/moonshine-sessions/s1-12345678';
  for (const bad of ['root', 'msplayer', 'MSplayer-123abc', 'msplayer-xyzxyz', '../evil-123abc']) {
    r = await helper(['add', bad, `${validDir}/home`]);
    assert.equal(r.code, 64, `${bad}: ${r.out}`);
    assert.match(r.out, /nome de usuário fora do padrão/);
  }

  // add: HOME fora do escopo.
  r = await helper(['add', 'msplayer-123abc', '/home/owner/.gamess/s1-12345678/home']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /HOME fora do escopo/);

  // chown: diretório fora do escopo (fora do root, com traversal).
  r = await helper(['chown', 'msplayer-123abc', '/etc']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /diretório fora do escopo/);
  r = await helper(['chown', 'msplayer-123abc', `${validDir}/../fora-12345678`]);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /diretório fora do escopo/);

  // release: fora do escopo.
  r = await helper(['release', '/home/owner']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /diretório fora do escopo/);

  // release: exige sudo (SUDO_USER limpo de propósito).
  r = await helper(['release', validDir], { env: { ...process.env, SUDO_USER: '' } });
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /exige invocação via sudo/);

  // del/kill: nomes fora do padrão.
  for (const op of ['del', 'kill']) {
    r = await helper([op, 'root']);
    assert.equal(r.code, 64, `${op}: ${r.out}`);
    assert.match(r.out, /nome de usuário fora do padrão/);
  }
});

test('ciclo real: cria sessão isolada e limpa tudo (Linux + sudo)', {
  skip: LINUX && SUDO_OK ? false : 'requer Linux com sudo sem senha (CI)',
}, async () => {
  const runtimeRoot = '/var/tmp/moonshine-sessions';
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o711 });
  let env;
  try {
    env = await isolation.createSessionEnvironment('777');

    // Usuário dedicado existe, com HOME temporário em /etc/passwd.
    assert.ok(env.unixUser, 'usuário dedicado deve ser criado');
    const pw = await execFileAsync('getent', ['passwd', env.unixUser]);
    assert.ok(pw.stdout.includes(env.home), `passwd deve apontar para o HOME temporário: ${pw.stdout}`);
    assert.ok(env.home.includes('s777-'), 'HOME deve ficar sob o diretório da sessão');

    // Diretório e HOME pertencem à sessão (não ao serviço) e HOME é 0700.
    const uid = Number((await execFileAsync('id', ['-u', env.unixUser])).stdout.trim());
    assert.notEqual(statSync(env.runtimeDir).uid, process.getuid());
    assert.equal(statSync(env.runtimeDir).uid, uid);
    assert.equal(statSync(env.home).uid, uid);
    assert.equal(statSync(env.home).mode & 0o777, 0o700);
    assert.equal(env.isolated, true);
  } catch (e) {
    // Não deixa lixo nem usuário para trás em caso de falha no meio.
    if (env) await isolation.discardSessionEnvironment(env).catch(() => {});
    throw e;
  }

  // Descarte: kill → release → rm → userdel, tudo via helper.
  const r = await isolation.discardSessionEnvironment(env);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(existsSync(env.runtimeDir), false, 'diretório da sessão deve sumir');

  // Usuário removido de verdade.
  await assert.rejects(() => execFileAsync('id', ['-u', env.unixUser]), 'usuário deve ser removido');

  // Verificação pós-limpeza: limpo.
  const v = await isolation.verifyCleanup(env);
  assert.equal(v.clean, true, v.problems.join('; '));
});
