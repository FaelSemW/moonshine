// Camada de persistência do HOST usando SQLite nativo do Node (node:sqlite).
//
// O banco guarda apenas metadados de gerenciamento: usuários (com hash),
// tokens de sessão revogáveis, reservas/estado da máquina e logs de eventos.
// Nenhuma senha em texto claro e nenhuma credencial da Steam.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'player',  -- 'player' | 'admin'
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  mode       TEXT    NOT NULL DEFAULT 'game',  -- permissão concedida: game|full
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL,
  ip         TEXT    NOT NULL,
  ok         INTEGER NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts(username, at);

-- Representa o estado atual da máquina (sempre uma linha com id=1).
CREATE TABLE IF NOT EXISTS machine (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  state          TEXT    NOT NULL,  -- offline|unavailable|available|preparing|in-use|cleaning|locked|error
  session_id     INTEGER,
  state_detail   TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id      INTEGER REFERENCES tokens(id) ON DELETE SET NULL,
  state         TEXT    NOT NULL,   -- reserved|preparing|active|ending|cleaning|closed|failed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  runtime_dir   TEXT,               -- diretório temporário da sessão
  unix_user     TEXT,               -- usuário Linux dedicado atribuído
  mode          TEXT    NOT NULL DEFAULT 'game',  -- 'game' (isolado) | 'full' (PC completo)
  cleanup_ok    INTEGER,            -- NULL pendente, 1 ok, 0 falhou
  cleanup_notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Códigos de convite: o operador gera no painel e envia ao jogador. O código é
-- a credencial dele (em vez de usuário/senha) e carrega o MODO concedido.
CREATE TABLE IF NOT EXISTS invite_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  mode       TEXT    NOT NULL DEFAULT 'game',   -- 'game' | 'full'
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note       TEXT,
  expires_at INTEGER,                           -- NULL = não expira
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_code ON invite_codes(code);

CREATE TABLE IF NOT EXISTS events_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  level   TEXT    NOT NULL,   -- info | warn | error
  message TEXT    NOT NULL,
  ctx     TEXT,               -- JSON opcional
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events_log(at);
`;

let db = null;

export function getDb() {
  if (db) return db;
  const file = join(DATA_DIR, 'moonshine.db');
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  ensureMachineRow(db);
  return db;
}

// Migra bancos criados antes da introdução do modo/convites. SQLite não altera
// colunas via CREATE TABLE IF NOT EXISTS, então adicionamos se faltarem.
function migrate(database) {
  const has = (table, col) =>
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === col);
  if (!has('tokens', 'mode')) {
    database.exec("ALTER TABLE tokens ADD COLUMN mode TEXT NOT NULL DEFAULT 'game'");
  }
  if (!has('sessions', 'mode')) {
    database.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'game'");
  }
}

function ensureMachineRow(database) {
  const row = database.prepare('SELECT id FROM machine WHERE id = 1').get();
  if (!row) {
    database
      .prepare(
        'INSERT INTO machine (id, state, state_detail, updated_at) VALUES (1, ?, ?, ?)'
      )
      .run('unavailable', 'inicializando', Date.now());
  }
}

export function now() {
  return Date.now();
}

// ---- Usuários ---------------------------------------------------------------

export function findUserByName(username) {
  return getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username));
}

export function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function createUser({ username, passwordHash, role = 'player' }) {
  const t = now();
  const info = getDb()
    .prepare(
      'INSERT INTO users (username, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
    )
    .run(String(username), passwordHash, role, t, t);
  return Number(info.lastInsertRowid);
}

export function updateUser(id, patch) {
  const fields = [];
  const vals = [];
  if (patch.passwordHash !== undefined) {
    fields.push('password_hash = ?');
    vals.push(patch.passwordHash);
  }
  if (patch.active !== undefined) {
    fields.push('active = ?');
    vals.push(patch.active ? 1 : 0);
  }
  if (patch.role !== undefined) {
    fields.push('role = ?');
    vals.push(patch.role);
  }
  if (!fields.length) return false;
  fields.push('updated_at = ?');
  vals.push(now(), Number(id));
  getDb()
    .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
    .run(...vals);
  return true;
}

export function listUsers() {
  return getDb()
    .prepare(
      'SELECT id, username, role, active, created_at, updated_at FROM users ORDER BY id'
    )
    .all();
}

export function deleteUser(id) {
  getDb().prepare('DELETE FROM tokens WHERE user_id = ?').run(Number(id));
  const info = getDb().prepare('DELETE FROM users WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

// ---- Tokens -----------------------------------------------------------------

export function insertToken({ userId, tokenHash, expiresAt, mode = 'game' }) {
  const info = getDb()
    .prepare(
      'INSERT INTO tokens (user_id, token_hash, mode, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)'
    )
    .run(Number(userId), tokenHash, mode === 'full' ? 'full' : 'game', now(), Number(expiresAt));
  return Number(info.lastInsertRowid);
}

export function findTokenByHash(tokenHash) {
  return getDb()
    .prepare('SELECT * FROM tokens WHERE token_hash = ?')
    .get(tokenHash);
}

export function revokeToken(id) {
  getDb()
    .prepare('UPDATE tokens SET revoked = 1 WHERE id = ?')
    .run(Number(id));
}

export function revokeAllTokensForUser(userId) {
  getDb()
    .prepare('UPDATE tokens SET revoked = 1 WHERE user_id = ?')
    .run(Number(userId));
}

export function purgeExpiredTokens() {
  getDb().prepare('DELETE FROM tokens WHERE expires_at < ?').run(now());
}

// ---- Tentativas de login (força bruta) --------------------------------------

export function recordLoginAttempt({ username, ip, ok }) {
  getDb()
    .prepare(
      'INSERT INTO login_attempts (username, ip, ok, at) VALUES (?, ?, ?, ?)'
    )
    .run(String(username), String(ip), ok ? 1 : 0, now());
}

export function recentFailedAttempts(username, since) {
  return getDb()
    .prepare(
      'SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND ok = 0 AND at >= ?'
    )
    .get(String(username), Number(since)).c;
}

export function clearAttempts(username) {
  getDb()
    .prepare('DELETE FROM login_attempts WHERE username = ?')
    .run(String(username));
}

export function listRecentAttempts(limit = 50) {
  return getDb()
    .prepare(
      'SELECT username, ip, ok, at FROM login_attempts ORDER BY at DESC LIMIT ?'
    )
    .all(Number(limit));
}

// ---- Máquina (estado global) -----------------------------------------------

export function getMachine() {
  return getDb().prepare('SELECT * FROM machine WHERE id = 1').get();
}

export function setMachineState(state, detail = null, sessionId = null) {
  getDb()
    .prepare(
      'UPDATE machine SET state = ?, state_detail = ?, session_id = ?, updated_at = ? WHERE id = 1'
    )
    .run(state, detail, sessionId, now());
}

// ---- Sessões ---------------------------------------------------------------

export function createSession({ userId, tokenId, mode = 'game', runtimeDir, unixUser }) {
  const t = now();
  const info = getDb()
    .prepare(
      'INSERT INTO sessions (user_id, token_id, mode, state, created_at, updated_at, runtime_dir, unix_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      Number(userId),
      tokenId ?? null,
      mode === 'full' ? 'full' : 'game',
      'reserved',
      t,
      t,
      runtimeDir ?? null,
      unixUser ?? null
    );
  return Number(info.lastInsertRowid);
}

export function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id));
}

export function updateSession(id, patch) {
  const map = {
    state: 'state',
    endedAt: 'ended_at',
    runtimeDir: 'runtime_dir',
    unixUser: 'unix_user',
    mode: 'mode',
    cleanupOk: 'cleanup_ok',
    cleanupNotes: 'cleanup_notes',
    tokenId: 'token_id',
  };
  const fields = [];
  const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      fields.push(`${col} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!fields.length) return false;
  fields.push('updated_at = ?');
  vals.push(now(), Number(id));
  getDb()
    .prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`)
    .run(...vals);
  return true;
}

export function openSessionFor(userId) {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE user_id = ? AND state IN ('reserved','preparing','active','ending','cleaning') ORDER BY id DESC LIMIT 1"
    )
    .get(Number(userId));
}

export function anyOpenSession() {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE state IN ('reserved','preparing','active','ending','cleaning') ORDER BY id DESC LIMIT 1"
    )
    .get();
}

export function listSessions(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT ?')
    .all(Number(limit));
}

// ---- Logs de eventos --------------------------------------------------------

export function logEvent(level, message, ctx = null) {
  getDb()
    .prepare(
      'INSERT INTO events_log (level, message, ctx, at) VALUES (?, ?, ?, ?)'
    )
    .run(level, String(message), ctx ? JSON.stringify(ctx) : null, now());
}

export function listEvents(limit = 200) {
  return getDb()
    .prepare('SELECT * FROM events_log ORDER BY at DESC LIMIT ?')
    .all(Number(limit));
}

// ---- Códigos de convite ------------------------------------------------------
//
// O código É a credencial do jogador (ele não tem usuário/senha). Cada código
// carrega o modo que concede ('game' isolado ou 'full' PC completo), validade e
// limite de usos. Gerado no painel pelo operador e enviado ao jogador.

export function createInvite({ code, mode = 'game', userId, note = null, expiresAt = null, maxUses = 1, createdBy = null }) {
  const info = getDb()
    .prepare(
      'INSERT INTO invite_codes (code, mode, user_id, note, expires_at, max_uses, uses, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)'
    )
    .run(
      String(code),
      mode === 'full' ? 'full' : 'game',
      Number(userId),
      note,
      expiresAt == null ? null : Number(expiresAt),
      Number(maxUses),
      createdBy,
      now()
    );
  return Number(info.lastInsertRowid);
}

export function findInviteByCode(code) {
  return getDb().prepare('SELECT * FROM invite_codes WHERE code = ?').get(String(code));
}

export function getInvite(id) {
  return getDb().prepare('SELECT * FROM invite_codes WHERE id = ?').get(Number(id));
}

export function listInvites(limit = 200) {
  return getDb()
    .prepare(
      'SELECT i.*, u.username AS username FROM invite_codes i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.id DESC LIMIT ?'
    )
    .all(Number(limit));
}

export function revokeInvite(id) {
  const info = getDb()
    .prepare('UPDATE invite_codes SET active = 0 WHERE id = ?')
    .run(Number(id));
  return info.changes > 0;
}

// Consome 1 uso do código de forma atômica e retorna true se o uso era válido
// (ativo, não expirado e com usos restantes). Corrida entre dois redeem
// simultâneos é resolvida pelo WHERE na própria atualização.
export function consumeInvite(id) {
  const info = getDb()
    .prepare(
      'UPDATE invite_codes SET uses = uses + 1 WHERE id = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?) AND uses < max_uses'
    )
    .run(Number(id), now());
  return info.changes > 0;
}

export function countInvites() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM invite_codes').get().c;
}
