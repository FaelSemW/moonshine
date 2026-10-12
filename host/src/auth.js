// Autenticação do HOST.
//
// - Senhas: scrypt (node:crypto), com salt aleatório por usuário, armazenadas
//   como "scrypt$N$r$p$saltB64$hashB64". Nunca texto claro.
// - Tokens: 256 bits de aleatoriedade, gravados apenas como SHA-256 no banco
//   para que um vazamento do banco não conceda sessões.
// - Força bruta: limite de tentativas falhas por janela de tempo.
//
// Nada disso envolve credenciais da Steam. O produto jamais pede, armazena ou
// transmite a senha da conta Steam do jogador.
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import * as db from './db.js';
import { loadConfig } from './config.js';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('A senha deve ter pelo menos 8 caracteres.');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- Tokens de sessão -------------------------------------------------------

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function issueToken(userId) {
  const cfg = loadConfig();
  const token = newToken();
  const id = db.insertToken({
    userId,
    tokenHash: hashToken(token),
    expiresAt: db.now() + cfg.tokenTtlMs,
  });
  return { token, tokenId: id };
}

// Valida um token de cliente e retorna o usuário ativo correspondente, ou null.
export function authenticateToken(token) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const row = db.findTokenByHash(hashToken(token));
  if (!row) return null;
  if (row.revoked) return null;
  if (row.expires_at < db.now()) return null;
  const user = db.findUserById(row.user_id);
  if (!user || !user.active) return null;
  return { user, tokenRow: row };
}

export function revokeTokenById(tokenId) {
  db.revokeToken(tokenId);
}

// ---- Login com proteção contra força bruta ----------------------------------

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export function login(username, password, ip = 'unknown') {
  const cfg = loadConfig();
  const user = db.findUserByName(username);

  // Janela de lockout baseada no tempo.
  const since = db.now() - cfg.loginMaxAttempts * cfg.loginLockoutMs;
  const fails = db.recentFailedAttempts(username, since);
  if (fails >= cfg.loginMaxAttempts) {
    db.recordLoginAttempt({ username, ip, ok: false });
    throw new AuthError(
      'Muitas tentativas falhas. Tente novamente mais tarde.',
      429
    );
  }

  // Verificação constante de tempo mesmo para usuário inexistente, para não
  // vazar existência por timing.
  const stored = user
    ? user.password_hash
    : hashPassword('placeholder-not-a-real-password');
  const okPassword = verifyPassword(password, stored);

  if (!user || !user.active || !okPassword) {
    db.recordLoginAttempt({ username, ip, ok: false });
    throw new AuthError('Credenciais inválidas.');
  }

  db.recordLoginAttempt({ username, ip, ok: true });
  db.clearAttempts(username);
  const { token, tokenId } = issueToken(user.id);
  return { user, token, tokenId };
}
