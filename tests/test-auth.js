import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDataDir, cleanupDataDir } from './helpers.js';

const dir = freshDataDir();
const auth = await import('../host/src/auth.js');
const db = await import('../host/src/db.js');

test.after(() => cleanupDataDir(dir));

test('hash de senha é scrypt e verifica corretamente', () => {
  const h = auth.hashPassword('senha-segura-123');
  assert.match(h, /^scrypt\$/);
  assert.equal(auth.verifyPassword('senha-segura-123', h), true);
  assert.equal(auth.verifyPassword('senha-errada', h), false);
});

test('senha muito curta é recusada', () => {
  assert.throws(() => auth.hashPassword('curta'), /8 caracteres/);
});

test('hash não contém a senha em texto claro', () => {
  const h = auth.hashPassword('minha-senha-secreta-9');
  assert.ok(!h.includes('minha-senha-secreta-9'));
});

test('login cria token e autentica; logout revoga', () => {
  db.createUser({ username: 'jogador1', passwordHash: auth.hashPassword('abcdefghij'), role: 'player' });
  const r = auth.login('jogador1', 'abcdefghij', '127.0.0.1');
  assert.ok(r.token && r.token.length >= 32);
  const a = auth.authenticateToken(r.token);
  assert.equal(a.user.username, 'jogador1');
  auth.revokeTokenById(r.tokenId);
  assert.equal(auth.authenticateToken(r.token), null);
});

test('login com senha errada falha', () => {
  assert.throws(() => auth.login('jogador1', 'senha-errada', '127.0.0.1'), /inválidas/);
});

test('força bruta é bloqueada após tentativas', () => {
  db.createUser({ username: 'vitima', passwordHash: auth.hashPassword('senha-forte-123'), role: 'player' });
  let bloqueado = false;
  for (let i = 0; i < 6; i++) {
    try {
      auth.login('vitima', 'errada-' + i, '10.0.0.1');
    } catch (e) {
      if (e.status === 429) { bloqueado = true; break; }
    }
  }
  assert.equal(bloqueado, true, 'deveria bloquear após 5 falhas');
});

test('token expirado não autentica', () => {
  const id = db.createUser({ username: 'expira', passwordHash: auth.hashPassword('senha-forte-xyz'), role: 'player' });
  const { token } = auth.issueToken(id);
  // Força expiração.
  db.getDb().prepare('UPDATE tokens SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, id);
  assert.equal(auth.authenticateToken(token), null);
});
