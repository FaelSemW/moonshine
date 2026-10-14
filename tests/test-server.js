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

test('detectTailscale devolve diagnóstico estável (binário ou Flatpak)', async () => {
  const probe = await import('../host/src/probe.js');
  const ts = probe.detectTailscale();
  assert.equal(typeof ts.installed, 'boolean');
  if (ts.installed) {
    assert.ok(['binary', 'flatpak'].includes(ts.via), `via inesperada: ${ts.via}`);
    const esperado = ts.via === 'flatpak' ? 'flatpak run --command=tailscale' : 'tailscale';
    assert.ok(ts.cliPrefix.startsWith(esperado), `cliPrefix: ${ts.cliPrefix}`);
  } else {
    assert.ok(ts.error, 'sem instalado deve explicar o erro');
    assert.equal(ts.cliPrefix, null);
  }
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

test('rede: GET mostra bind e Tailscale; POST valida bindHost', async () => {
  const t = await login('admin', 'senha-admin-123');
  // GET
  let r = await j('/api/admin/network', { token: t });
  assert.equal(r.status, 200);
  assert.ok(r.data.bindHost);
  assert.ok(r.data.tailscale);
  // POST com bindHost inválido.
  r = await j('/api/admin/network', { method: 'POST', token: t, body: { bindHost: '$(rm -rf /)' } });
  assert.equal(r.status, 400);
  // POST com sunshineAddress inválido.
  r = await j('/api/admin/network', { method: 'POST', token: t, body: { sunshineAddress: 'host sem porta' } });
  assert.equal(r.status, 400);
  // POST válido (bindHost padrão mantido).
  r = await j('/api/admin/network', { method: 'POST', token: t, body: { bindHost: '127.0.0.1' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.requiresRestart, true);
});

test('convite: criar → resgatar → modo full na sessão (PC completo)', async () => {
  const t = await login('admin', 'senha-admin-123');
  // Cria convite modo full, 1 uso.
  let r = await j('/api/admin/invites', {
    method: 'POST',
    token: t,
    body: { mode: 'full', maxUses: 1, note: 'amigo' },
  });
  assert.equal(r.status, 201);
  const code = r.data.code;
  assert.ok(code && r.data.mode === 'full');

  // Lista contém o convite.
  r = await j('/api/admin/invites', { token: t });
  assert.equal(r.status, 200);
  assert.ok(r.data.invites.some((i) => i.code === code));

  // Resgata: concede token com modo full.
  r = await j('/api/redeem', { method: 'POST', body: { code } });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'full');
  const ft = r.data.token;
  assert.ok(ft);

  // Reserva → modo full.
  r = await j('/api/session/reserve', { method: 'POST', token: ft });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'full');
  const sid = r.data.sessionId;

  // Prepare → modo full, sem isolamento de SO (é o objetivo do PC completo).
  r = await j('/api/session/prepare', { method: 'POST', token: ft, body: { sessionId: sid } });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'full');
  assert.equal(r.data.isolation.isolated, false);

  // Encerra.
  r = await j('/api/session/end', { method: 'POST', token: ft, body: { sessionId: sid } });
  assert.equal(r.status, 200);

  // max_uses=1: resgatar de novo falha.
  r = await j('/api/redeem', { method: 'POST', body: { code } });
  assert.equal(r.status, 401);
});

test('convite: código inválido, revogado e expirado retornam 401', async () => {
  const t = await login('admin', 'senha-admin-123');
  // Inválido.
  let r = await j('/api/redeem', { method: 'POST', body: { code: 'NADA-NADA' } });
  assert.equal(r.status, 401);

  // Revogado.
  r = await j('/api/admin/invites', { method: 'POST', token: t, body: { mode: 'game' } });
  const code = r.data.code;
  r = await j('/api/admin/invites/revoke', {
    method: 'POST',
    token: t,
    body: { id: r.data.inviteId },
  });
  assert.equal(r.status, 200);
  r = await j('/api/redeem', { method: 'POST', body: { code } });
  assert.equal(r.status, 401);

  // Expirado (validade mínima + espera).
  r = await j('/api/admin/invites', {
    method: 'POST',
    token: t,
    body: { mode: 'game', expiresInMin: 0.0001 },
  });
  const ecode = r.data.code;
  await new Promise((res) => setTimeout(res, 40));
  r = await j('/api/redeem', { method: 'POST', body: { code: ecode } });
  assert.equal(r.status, 401);
});

test('convite: criar/listar exige admin (jogador negado)', async () => {
  const tj = await login('jogadorx', 'senha-jogador-99');
  let r = await j('/api/admin/invites', { method: 'POST', token: tj, body: { mode: 'game' } });
  assert.equal(r.status, 403);
  r = await j('/api/admin/invites', { token: tj });
  assert.equal(r.status, 403);
});

test('login por senha fica no modo game (padrão) e prepare isola', async () => {
  const t = await login('jogadorx', 'senha-jogador-99');
  let r = await j('/api/session/reserve', { method: 'POST', token: t });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'game');
  const sid = r.data.sessionId;

  r = await j('/api/session/prepare', { method: 'POST', token: t, body: { sessionId: sid } });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'game');

  r = await j('/api/session/end', { method: 'POST', token: t, body: { sessionId: sid } });
  assert.equal(r.status, 200);
});

test('auto-pair: app envia o PIN e o HOST repassa ao Sunshine (API oficial)', async () => {
  const t = await login('admin', 'senha-admin-123');
  let posted = null;
  const PAIR_ID = '0123456789abcdef0123456789abcdef';
  sunshine.__setConfigOverride((method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/pin')) {
      return {
        ok: true,
        status: 200,
        json: () => ({ pairings: [{ id: PAIR_ID, name: 'dev', address: '127.0.0.1' }] }),
      };
    }
    if (method === 'POST' && path === '/api/pin') {
      posted = body;
      return { ok: true, status: 200, json: () => ({ status: 'ok' }) };
    }
    return { ok: true, status: 200, json: () => ({}) };
  });
  try {
    // Sem token → 401.
    let r = await j('/api/pair/pin', { method: 'POST', body: { pin: '1234' } });
    assert.equal(r.status, 401);
    // PIN fora do formato → 400.
    r = await j('/api/pair/pin', { method: 'POST', token: t, body: { pin: '12' } });
    assert.equal(r.status, 400);
    // Fluxo feliz: 200 e o Sunshine recebe pairing_id + pin + name.
    r = await j('/api/pair/pin', { method: 'POST', token: t, body: { pin: '1234', name: 'Moto G' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.deepEqual(posted, { pairing_id: PAIR_ID, pin: '1234', name: 'Moto G' });
  } finally {
    sunshine.__setConfigOverride(null);
  }
});

test('auto-pair: sem pareamento pendente no Sunshine → 409', async () => {
  const t = await login('admin', 'senha-admin-123');
  sunshine.__setConfigOverride(() => ({ ok: true, status: 200, json: () => ({ pairings: [] }) }));
  try {
    const r = await j('/api/pair/pin', { method: 'POST', token: t, body: { pin: '5678' } });
    assert.equal(r.status, 409);
  } finally {
    sunshine.__setConfigOverride(null);
  }
});

test('auto-pair: API do Sunshine inacessível/sem credenciais → 502 (não 409)', async () => {
  const t = await login('admin', 'senha-admin-123');
  sunshine.__setConfigOverride(() => ({ ok: false, status: 401, json: () => ({}) }));
  try {
    const r = await j('/api/pair/pin', { method: 'POST', token: t, body: { pin: '9999' } });
    assert.equal(r.status, 502);
  } finally {
    sunshine.__setConfigOverride(null);
  }
});

async function login(username, password) {
  const r = await j('/api/login', { method: 'POST', body: { username, password } });
  return r.data.token;
}
