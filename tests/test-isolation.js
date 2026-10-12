import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDataDir, cleanupDataDir } from './helpers.js';
import { mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const dir = freshDataDir();
const isolation = await import('../host/src/isolation.js');
const { loadConfig } = await import('../host/src/config.js');

test.after(() => cleanupDataDir(dir));

test('assertInside aceita caminho dentro da raiz', () => {
  const root = join(dir, 'sessions');
  mkdirSync(root, { recursive: true });
  assert.equal(isolation.assertInside(root, join(root, 'abc')), true);
});

test('assertInside recusa path traversal', () => {
  const root = join(dir, 'sessions');
  assert.throws(() => isolation.assertInside(root, join(root, '..', 'fora')), /fora do escopo/);
});

test('assertInside recusa caminho absoluto fora da raiz', () => {
  const root = join(dir, 'sessions');
  assert.throws(() => isolation.assertInside(root, '/etc/passwd'), /fora do escopo/);
});

test('assertInside recusa symlink que escapa', () => {
  const root = join(dir, 'sessions');
  mkdirSync(root, { recursive: true });
  const alvo = join(dir, 'secreto');
  mkdirSync(alvo, { recursive: true });
  const link = join(root, 'link');
  try {
    symlinkSync(alvo, link);
    assert.throws(() => isolation.assertInside(root, link), /symlink/);
  } catch {
    // symlink pode exigir privilégio no Windows; pula se não der.
  }
});

test('cria e descarta ambiente temporário (temp-home)', async () => {
  const env = await isolation.createSessionEnvironment(101);
  assert.ok(env.runtimeDir.includes('s101'));
  assert.ok(existsSync(env.home));
  const r = await isolation.discardSessionEnvironment(env);
  assert.equal(r.ok, true);
  assert.equal(existsSync(env.runtimeDir), false);
});

test('descarte recusa ambiente fora do escopo', async () => {
  const cfg = loadConfig();
  const malicioso = { runtimeDir: join(dir, '..', 'nao-deveria'), unixUser: null };
  await assert.rejects(
    () => isolation.discardSessionEnvironment(malicioso),
    /fora do escopo/
  );
  void cfg;
});

test('verifyCleanup detecta diretório que persiste', async () => {
  const env = await isolation.createSessionEnvironment(202);
  // Não descarta: simula limpeza incompleta.
  const v = await isolation.verifyCleanup(env);
  assert.equal(v.clean, false);
  assert.ok(v.problems.length > 0);
  // Limpa de verdade agora.
  await isolation.discardSessionEnvironment(env);
  const v2 = await isolation.verifyCleanup(env);
  assert.equal(v2.clean, true);
});
