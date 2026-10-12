// Ponto de entrada do HOST Moonshine.
import { createHttpServer } from './server.js';
import { loadConfig } from './config.js';
import * as db from './db.js';
import * as session from './session.js';
import * as sunshine from './sunshine.js';
import { compatibilityReport } from './probe.js';

const cfg = loadConfig();

// Inicializa o banco e registra o estado inicial.
const database = db.getDb();
void database;
db.purgeExpiredTokens();

// Estado inicial da máquina: 'available' se conseguimos falar com o Sunshine,
// senão 'unavailable'. Nunca assumimos 'in-use' sem confirmação.
const info = await sunshine.readServerInfo();
if (info.reachable) {
  db.setMachineState('available', 'Sunshine alcançável', null);
} else {
  db.setMachineState('unavailable', `Sunshine indisponível: ${info.error || 'sem resposta'}`, null);
}
db.logEvent('info', 'HOST iniciado', {
  platform: process.platform,
  isolation: cfg.isolationMode,
  sunshineReachable: info.reachable,
});

// Relatório de compatibilidade no boot (diagnóstico, não bloqueia).
const compat = compatibilityReport();
if (compat.issues.length) {
  for (const i of compat.issues) db.logEvent('warn', 'compatibilidade', { issue: i });
}

const server = createHttpServer();

// Polling: detecta fim de sessão real (Sunshine voltou a livre) e expira tokens.
const POLL_MS = 3000;
const pollTimer = setInterval(async () => {
  try {
    await session.pollActiveSession();
  } catch (e) {
    db.logEvent('error', 'falha no polling de sessão', { msg: e.message });
  }
}, POLL_MS);

const purgeTimer = setInterval(() => {
  try {
    db.purgeExpiredTokens();
  } catch {
    /* melhor esforço */
  }
}, 5 * 60 * 1000);

server.listen(cfg.port, cfg.bindHost, () => {
  console.log(`[moonshine] HOST em http://${cfg.bindHost}:${cfg.port}`);
  console.log(`[moonshine] isolamento: ${cfg.isolationMode}`);
  console.log(`[moonshine] Sunshine: ${cfg.sunshineAddress} (${info.reachable ? 'ok' : 'inacessível'})`);
  if (db.countUsers() === 0) {
    console.log(`[moonshine] Configuração inicial: abra a interface e crie o administrador.`);
  }
});

function shutdown(signal) {
  console.log(`[moonshine] encerrando (${signal})`);
  clearInterval(pollTimer);
  clearInterval(purgeTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
