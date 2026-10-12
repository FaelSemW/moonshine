import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDataDir, cleanupDataDir } from './helpers.js';

const dir = freshDataDir();
const db = await import('../host/src/db.js');
const auth = await import('../host/src/auth.js');
const session = await import('../host/src/session.js');
const sunshine = await import('../host/src/sunshine.js');

test.after(() => cleanupDataDir(dir));

// Simula Sunshine alcançável para o teste do ciclo (o plano de controle é o
// alvo aqui; o streaming real é validado em hardware).
function fakeSunshine(busy) {
  sunshine.__setServerInfoOverride(() => ({ reachable: true, busy, currentGame: busy ? 1 : 0, hostname: 'test' }));
}

test('reserva impede sessões simultâneas (dois jogadores)', () => {
  const a = db.createUser({ username: 'p1', passwordHash: auth.hashPassword('senha-jogador-1'), role: 'player' });
  const b = db.createUser({ username: 'p2', passwordHash: auth.hashPassword('senha-jogador-2'), role: 'player' });
  db.setMachineState('available', 'teste', null);
  const u1 = db.findUserById(a);
  const u2 = db.findUserById(b);
  const r1 = session.reserveSession(u1, null);
  assert.ok(r1.session.id);
  // Segunda reserva deve falhar (ocupada).
  assert.throws(() => session.reserveSession(u2, null), /ocupada|sessão aberta/i);
  // Limpa para os próximos testes.
  db.updateSession(r1.session.id, { state: 'closed', cleanupOk: 1 });
  db.setMachineState('available', null, null);
});

test('mesmo usuário reconecta sem duplicar sessão', () => {
  const id = db.createUser({ username: 'reconecta', passwordHash: auth.hashPassword('senha-reconecta'), role: 'player' });
  const u = db.findUserById(id);
  db.setMachineState('available', null, null);
  const r1 = session.reserveSession(u, null);
  const r2 = session.reserveSession(u, null);
  assert.equal(r1.session.id, r2.session.id);
  assert.equal(r2.resumed, true);
  db.updateSession(r1.session.id, { state: 'closed', cleanupOk: 1 });
  db.setMachineState('available', null, null);
});

test('ciclo completo: preparar → ativa → limpar → liberar', async () => {
  fakeSunshine(false);
  const id = db.createUser({ username: 'ciclo', passwordHash: auth.hashPassword('senha-ciclo-full'), role: 'player' });
  const u = db.findUserById(id);
  db.setMachineState('available', null, null);
  const { session: s } = session.reserveSession(u, null);

  const prep = await session.prepareSession(s.id);
  assert.equal(prep.session.state, 'active');
  assert.equal(db.getMachine().state, 'in-use');
  assert.ok(prep.streamTarget);

  // Encerra e limpa.
  const r = await session.cleanupSession(s.id, { reason: 'teste' });
  assert.equal(r.ok, true);
  assert.equal(db.getSession(s.id).state, 'closed');
  assert.equal(db.getSession(s.id).cleanup_ok, 1);
  assert.equal(db.getMachine().state, 'available');
});

test('fim de sessão detectado por Sunshine livre dispara limpeza', async () => {
  fakeSunshine(false);
  const id = db.createUser({ username: 'detected', passwordHash: auth.hashPassword('senha-detected-1'), role: 'player' });
  const u = db.findUserById(id);
  db.setMachineState('available', null, null);
  const { session: s } = session.reserveSession(u, null);
  await session.prepareSession(s.id);
  assert.equal(db.getMachine().state, 'in-use');

  // Sunshine continua livre (jogador saiu) → poll deve encerrar e limpar.
  const res = await session.pollActiveSession();
  assert.equal(res.ended, true);
  assert.equal(db.getMachine().state, 'available');
});

test('máquina travada não aceita nova sessão até unlock', async () => {
  fakeSunshine(false);
  // Força uma limpeza falhando: aponta runtime_dir inexistente de escopo mas com
  // dados que impedem verificação. Simulamos definindo estado locked diretamente.
  db.setMachineState('locked', 'limpeza incompleta simulada', null);
  const id = db.createUser({ username: 'bloqueado', passwordHash: auth.hashPassword('senha-bloq-123'), role: 'player' });
  const u = db.findUserById(id);
  assert.throws(() => session.reserveSession(u, null), /bloqueada/i);

  // Recuperação administrativa.
  const r = session.adminForceUnlock({ operator: 'admin' });
  assert.equal(r.ok, true);
  assert.equal(db.getMachine().state, 'available');
});
