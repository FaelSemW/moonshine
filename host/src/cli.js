#!/usr/bin/env node
// CLI do Moonshine — diagnóstico e configuração do HOST na Bazzite.
//
// Uso:
//   node host/src/cli.js doctor          # verifica ambiente, Sunshine e recursos
//   node host/src/cli.js setup-sunshine  # configura credenciais + app Desktop
//   node host/src/cli.js create-user <user> <pass> [player|admin]
//   node host/src/cli.js state           # mostra estado atual da máquina
//   node host/src/cli.js unlock          # libera máquina travada (recuperação)
//
// É o mesmo código do serviço; não há dependências externas.
import * as db from './db.js';
import * as auth from './auth.js';
import * as sunshine from './sunshine.js';
import * as session from './session.js';
import { compatibilityReport } from './probe.js';
import { loadConfig } from './config.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const [, , cmd, ...args] = process.argv;

const rl = createInterface({ input: stdin, output: stdout });
async function ask(q) {
  return (await rl.question(q)).trim();
}

function print(o) {
  console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
}

async function doctor() {
  const cfg = loadConfig();
  db.getDb(); // inicializa
  console.log('== Moonshine · diagnóstico ==\n');
  const compat = compatibilityReport();
  print({
    plataforma: compat.os.platform,
    so: compat.os.osRelease?.pretty || compat.os.release,
    bazzite: compat.os.osRelease?.isBazzite || false,
    gpu: compat.gpu.gpus,
    fornecedorGPU: compat.gpu.vendor,
    ramGb: compat.resources.memTotalGb,
    cpu: `${compat.resources.cpuModel} (${compat.resources.cpuCount})`,
  });
  if (compat.issues.length) {
    console.log('\nProblemas:');
    compat.issues.forEach((i) => console.log('  - ' + i));
  }
  if (compat.notes.length) {
    console.log('\nNotas:');
    compat.notes.forEach((n) => console.log('  - ' + n));
  }

  console.log('\n== Sunshine ==');
  const info = await sunshine.readServerInfo();
  print({
    acessivel: info.reachable,
    hostname: info.hostname,
    ocupado: info.busy,
    jogoAtual: info.currentGame || null,
    erro: info.error || null,
  });

  const pairing = await sunshine.readPairingStatus();
  console.log('\n== Pareamento ==');
  print({
    clientesPareados: pairing.clients?.named_certs?.length ?? 'indisponível',
    pendentes: pairing.pending?.pairings?.length ?? 'indisponível',
    erro: pairing.error,
  });

  const machine = db.getMachine();
  console.log('\n== Máquina ==');
  print({
    estado: machine.state,
    detalhe: machine.state_detail,
    usuarios: db.countUsers(),
  });

  const ok = info.reachable;
  console.log(`\nResultado: ${ok ? 'OK — Sunshine acessível' : 'SUNSHINE INACESSÍVEL (inicie o Flatpak)'}`);
  rl.close();
  process.exit(ok ? 0 : 1);
}

async function setupSunshine() {
  console.log('== Configuração do Sunshine ==\n');
  // Tenta iniciar o Sunshine se não estiver no ar.
  let info = await sunshine.readServerInfo();
  if (!info.reachable) {
    console.log('Sunshine indisponível; tentando iniciar…');
    const start = await sunshine.ensureSunshineRunning();
    print(start);
    await new Promise((r) => setTimeout(r, 3000));
    info = await sunshine.readServerInfo();
  }
  if (!info.reachable) {
    console.log('ERRO: Sunshine não respondeu na porta GameStream (47989).');
    console.log('Abra o Sunshine (Flatpak) e rode de novo.');
    rl.close();
    process.exit(1);
  }
  console.log(`Sunshine acessível (${info.hostname || 'ok'}).\n`);

  const haveCreds = sunshine.getSunshineCredentials().username;
  const cur = haveCreds ? 'deixar em branco para manter' : 'usuário da Web UI';
  const u = await ask(`Usuário da Web UI do Sunshine [${cur}]: `);
  if (u) {
    const p = await ask('Senha da Web UI do Sunshine: ');
    sunshine.setSunshineCredentials(u, p);
    console.log('Credenciais salvas (persistidas no config, 0600).');
  } else if (!haveCreds) {
    console.log('Sem credenciais; o HOST só lerá o estado (sem fechar apps à distância).');
  }

  console.log('\nGarantindo app "Desktop" no Sunshine…');
  const app = await sunshine.ensureDesktopApp();
  print(app);

  const pairing = await sunshine.readPairingStatus();
  console.log('\nPareie o Moonlight:');
  console.log('  1. Abra o Moonlight e adicione este host (IP/GameStream).');
  console.log('  2. Quando aparecer o PIN, informe-o no painel (Sunshine → Parear).');
  print({ clientesPareados: pairing.clients?.named_certs?.length ?? 0 });

  rl.close();
  process.exit(0);
}

async function createUser(username, password, role = 'player') {
  db.getDb();
  if (!username || !password) {
    console.log('Uso: create-user <usuario> <senha> [player|admin]');
    process.exit(1);
  }
  if (db.findUserByName(username)) {
    console.log('Usuário já existe.');
    process.exit(1);
  }
  const hash = auth.hashPassword(password);
  const id = db.createUser({ username, passwordHash: hash, role });
  console.log(`Usuário criado (id=${id}, papel=${role}).`);
  process.exit(0);
}

async function showState() {
  db.getDb();
  const m = db.getMachine();
  print({ estado: m.state, detalhe: m.state_detail, sessao: m.session_id, atualizado: new Date(m.updated_at).toISOString() });
  process.exit(0);
}

async function unlock() {
  db.getDb();
  try {
    const r = session.adminForceUnlock({ operator: 'cli' });
    print(r);
    process.exit(0);
  } catch (e) {
    console.log('ERRO: ' + e.message);
    process.exit(1);
  }
}

switch (cmd) {
  case 'doctor': await doctor(); break;
  case 'setup-sunshine': await setupSunshine(); break;
  case 'create-user': await createUser(args[0], args[1], args[2] || 'player'); break;
  case 'state': await showState(); break;
  case 'unlock': await unlock(); break;
  default:
    console.log('Moonshine CLI');
    console.log('  doctor           diagnóstico do ambiente e Sunshine');
    console.log('  setup-sunshine   configura credenciais e app Desktop');
    console.log('  create-user u p  cria usuário (player|admin)');
    console.log('  state            mostra estado da máquina');
    console.log('  unlock           libera máquina travada');
    process.exit(cmd ? 1 : 0);
}
