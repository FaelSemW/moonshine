import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDataDir, cleanupDataDir } from './helpers.js';

const dir = freshDataDir();
const { createHttpServer } = await import('../host/src/server.js');
const db = await import('../host/src/db.js');
const sunshine = await import('../host/src/sunshine.js');

// Sunshine alcançável para o teste de integração.
sunshine.__setServerInfoOverride(() => ({ reachable: true, busy: false, currentGame: 0, hostname: 'test' }));

let server;
let base;

test.before(async () => {
  server = createHttpServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  cleanupDataDir(dir);
});

async function j(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('health responde ok sem autenticação', async () => {
  const r = await j('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('setup-required relata necessário antes do setup', async () => {
  const r = await j('/api/setup-required');
  assert.equal(r.data.required, true);
});

test('fluxo: setup → login → estado → reserva → admin', async () => {
  // Setup do admin.
  let r = await j('/api/setup', { method: 'POST', body: { username: 'admin', password: 'senha-admin-123' } });
  assert.equal(r.status, 201);

  // Setup de novo admin é recusado.
  r = await j('/api/setup', { method: 'POST', body: { username: 'admin2', password: 'senha-admin-456' } });
  assert.equal(r.status, 400);

  // Login.
  r = await j('/api/login', { method: 'POST', body: { username: 'admin', password: 'senha-admin-123' } });
  assert.equal(r.status, 200);
  const token = r.data.token;
  assert.ok(token);

  // Estado autenticado.
  r = await j('/api/state', { token });
  assert.equal(r.status, 200);
  assert.ok(r.data.machine);

  // Reserva.
  r = await j('/api/session/reserve', { method: 'POST', token });
  assert.equal(r.status, 200);
  const sid = r.data.sessionId;

  // Preparar.
  r = await j('/api/session/prepare', { method: 'POST', token, body: { sessionId: sid } });
  assert.equal(r.status, 200);
  assert.equal(r.data.state, 'active');

  // Heartbeat.
  r = await j('/api/session/heartbeat', { method: 'POST', token, body: { sessionId: sid } });
  assert.equal(r.status, 200);

  // Admin: lista usuários.
  r = await j('/api/admin/users', { token });
  assert.equal(r.status, 200);
  assert.ok(r.data.users.length >= 1);

  // Encerrar sessão.
  r = await j('/api/session/end', { method: 'POST', token, body: { sessionId: sid } });
  assert.equal(r.status, 200);
});

test('acesso administrativo negado para papel de jogador', async () => {
  // Cria jogador.
  await j('/api/admin/users', {
    method: 'POST',
    token: (await login('admin', 'senha-admin-123')),
    body: { username: 'jogadorx', password: 'senha-jogador-99', role: 'player' },
  });
  const t = await login('jogadorx', 'senha-jogador-99');
  const r = await j('/api/admin/users', { token: t });
  assert.equal(r.status, 403);
});

test('rota sem token retorna 401', async () => {
  const r = await j('/api/state');
  assert.equal(r.status, 401);
});

test('login errado retorna 401', async () => {
  const r = await j('/api/login', { method: 'POST', body: { username: 'admin', password: 'errada-errada' } });
  assert.equal(r.status, 401);
});

test('traversal de path estático é bloqueado', async () => {
  const res = await fetch(`${base}/../../package.json`);
  const txt = await res.text();
  assert.ok(!txt.includes('"scripts"'), 'não deve expor package.json');
});

test('rota de pareamento valida PIN e pairingId', async () => {
  const t = await login('admin', 'senha-admin-123');
  // PIN inválido.
  let r = await j('/api/admin/sunshine/pairing', { method: 'POST', token: t, body: { pairingId: 'a'.repeat(32), pin: '12' } });
  assert.equal(r.status, 400);
  // pairingId inválido.
  r = await j('/api/admin/sunshine/pairing', { method: 'POST', token: t, body: { pairingId: 'xyz', pin: '1234' } });
  assert.equal(r.status, 400);
  // GET de pareamento responde (Sunshine pode estar fora do ar aqui).
  r = await j('/api/admin/sunshine/pairing', { token: t });
  assert.equal(r.status, 200);
});

test('rota desktop-app exige admin', async () => {
  const tj = await login('jogadorx', 'senha-jogador-99');
  const r = await j('/api/admin/sunshine/desktop-app', { method: 'POST', token: tj });
  assert.equal(r.status, 403);
});

async function login(username, password) {
  const r = await j('/api/login', { method: 'POST', body: { username, password } });
  return r.data.token;
}
