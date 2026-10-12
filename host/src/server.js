// Servidor HTTP do HOST: API de controle autenticada + painel administrativo
// integrado + cliente web. Sem dependências externas (node:http nativo).
//
// Segurança (docs/SECURITY.md):
//  - Escuta em loopback por padrão; atrás do Tailscale Serve na implantação.
//  - Tokens Bearer, revogáveis, hasheados no banco.
//  - Rate limit de login (força bruta).
//  - Nenhum comando arbitrário vindo da rede; nenhuma rota que aceite caminho
//    de arquivo do cliente. Validação de corpo e limites de tamanho.
//  - Cabeçalhos de segurança em toda resposta.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as db from './db.js';
import * as auth from './auth.js';
import * as session from './session.js';
import * as sunshine from './sunshine.js';
import { compatibilityReport } from './probe.js';
import { loadConfig } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY = 64 * 1024; // 64 KB — nunca esperamos uploads grandes.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Lê e valida o corpo JSON com limite de tamanho.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'corpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON inválido'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'erro de leitura')));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
}

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

// Extrai o token Bearer.
function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function requireAuth(req) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'autenticação necessária');
  const a = auth.authenticateToken(token);
  if (!a) throw new HttpError(401, 'sessão inválida ou expirada');
  return a;
}

function requireAdmin(req) {
  const a = requireAuth(req);
  if (a.user.role !== 'admin') throw new HttpError(403, 'privilégio de administrador necessário');
  return a;
}

// Valida campos de usuário contra injeção/valores maliciosos.
function validateUserFields({ username, password, role }) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'usuário inválido (3-32 caracteres: letras, números, . _ -)');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'senha inválida (8-200 caracteres)');
  }
  if (role !== undefined && !['player', 'admin'].includes(role)) {
    throw new HttpError(400, 'papel inválido');
  }
}

// ---- Rotas ------------------------------------------------------------------

async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  // Estado público mínimo para o cliente decidir se precisa autenticar.
  if (method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'moonshine-host', ts: db.now() });
  }

  // Bootstrap: cria o primeiro administrador quando não há nenhum.
  if (method === 'POST' && path === '/api/setup') {
    if (db.countUsers() > 0) {
      throw new HttpError(400, 'configuração inicial já concluída');
    }
    const body = await readJsonBody(req);
    validateUserFields({ ...body, role: 'admin' });
    const hash = auth.hashPassword(body.password);
    const id = db.createUser({ username: body.username, passwordHash: hash, role: 'admin' });
    db.logEvent('info', 'administrador criado', { username: body.username });
    return sendJson(res, 201, { ok: true, userId: id });
  }

  if (method === 'GET' && path === '/api/setup-required') {
    return sendJson(res, 200, { required: db.countUsers() === 0 });
  }

  // Login.
  if (method === 'POST' && path === '/api/login') {
    const body = await readJsonBody(req);
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'credenciais ausentes');
    }
    try {
      const r = auth.login(username, password, clientIp(req));
      return sendJson(res, 200, {
        token: r.token,
        user: { id: r.user.id, username: r.user.username, role: r.user.role },
      });
    } catch (e) {
      if (e instanceof auth.AuthError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // Logout (revoga o token atual).
  if (method === 'POST' && path === '/api/logout') {
    const a = requireAuth(req);
    auth.revokeTokenById(a.tokenRow.id);
    return sendJson(res, 200, { ok: true });
  }

  // Estado da máquina (autenticado).
  if (method === 'GET' && path === '/api/state') {
    requireAuth(req);
    return sendJson(res, 200, publicState());
  }

  // Reservar sessão.
  if (method === 'POST' && path === '/api/session/reserve') {
    const a = requireAuth(req);
    if (a.user.role !== 'admin' && a.user.role !== 'player') {
      throw new HttpError(403, 'sem permissão');
    }
    try {
      const { session: s, resumed } = session.reserveSession(a.user, a.tokenRow.id);
      return sendJson(res, 200, { sessionId: s.id, resumed, state: s.state });
    } catch (e) {
      if (e instanceof session.SessionError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // Preparar sessão (cria ambiente + confirma streaming).
  if (method === 'POST' && path === '/api/session/prepare') {
    const a = requireAuth(req);
    const body = await readJsonBody(req);
    const sid = Number(body.sessionId);
    const mine = db.getSession(sid);
    if (!mine || mine.user_id !== a.user.id) throw new HttpError(404, 'sessão inexistente');
    try {
      const r = await session.prepareSession(sid);
      return sendJson(res, 200, {
        sessionId: r.session.id,
        state: r.session.state,
        streamTarget: r.streamTarget,
        isolation: r.isolation,
        library: r.library,
      });
    } catch (e) {
      if (e instanceof session.SessionError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // Heartbeat do cliente para saber se a sessão continua confirmada.
  if (method === 'POST' && path === '/api/session/heartbeat') {
    const a = requireAuth(req);
    const body = await readJsonBody(req);
    const sid = Number(body.sessionId);
    const mine = db.getSession(sid);
    if (!mine || mine.user_id !== a.user.id) throw new HttpError(404, 'sessão inexistente');
    return sendJson(res, 200, { sessionId: sid, state: mine.state, machine: publicState().machine });
  }

  // Encerrar sessão pelo cliente.
  if (method === 'POST' && path === '/api/session/end') {
    const a = requireAuth(req);
    const body = await readJsonBody(req);
    const sid = Number(body.sessionId);
    const mine = db.getSession(sid);
    if (!mine || mine.user_id !== a.user.id) throw new HttpError(404, 'sessão inexistente');
    try {
      await session.cleanupSession(sid, { reason: 'encerrado pelo cliente' });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof session.SessionError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // ---- Admin ----
  if (path.startsWith('/api/admin/')) {
    return handleAdmin(req, res, url, path.replace('/api/admin/', ''));
  }

  throw new HttpError(404, 'rota não encontrada');
}

async function handleAdmin(req, res, url, sub) {
  const method = req.method;

  if (sub === 'users' && method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, { users: db.listUsers() });
  }
  if (sub === 'users' && method === 'POST') {
    requireAdmin(req);
    const body = await readJsonBody(req);
    validateUserFields(body);
    if (db.findUserByName(body.username)) throw new HttpError(409, 'usuário já existe');
    const hash = auth.hashPassword(body.password);
    const id = db.createUser({ username: body.username, passwordHash: hash, role: body.role || 'player' });
    return sendJson(res, 201, { ok: true, userId: id });
  }
  if (sub.startsWith('users/') && method === 'PUT') {
    requireAdmin(req);
    const id = Number(sub.split('/')[1]);
    const target = db.findUserById(id);
    if (!target) throw new HttpError(404, 'usuário inexistente');
    const body = await readJsonBody(req);
    const patch = {};
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 8) {
        throw new HttpError(400, 'senha inválida');
      }
      patch.passwordHash = auth.hashPassword(body.password);
    }
    if (body.active !== undefined) patch.active = !!body.active;
    if (body.role !== undefined) {
      if (!['player', 'admin'].includes(body.role)) throw new HttpError(400, 'papel inválido');
      patch.role = body.role;
    }
    db.updateUser(id, patch);
    if (body.active === false || body.password !== undefined) {
      db.revokeAllTokensForUser(id); // força re-login
    }
    return sendJson(res, 200, { ok: true });
  }
  if (sub.startsWith('users/') && method === 'DELETE') {
    const a = requireAdmin(req);
    const id = Number(sub.split('/')[1]);
    if (id === a.user.id) throw new HttpError(400, 'não é possível remover a si mesmo');
    const ok = db.deleteUser(id);
    if (!ok) throw new HttpError(404, 'usuário inexistente');
    return sendJson(res, 200, { ok: true });
  }

  if (sub === 'sessions' && method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, { sessions: db.listSessions() });
  }
  if (sub === 'machine/unlock' && method === 'POST') {
    const a = requireAdmin(req);
    try {
      const r = session.adminForceUnlock({ operator: a.user.username });
      return sendJson(res, 200, r);
    } catch (e) {
      if (e instanceof session.SessionError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  if (sub === 'machine/cleanup' && method === 'POST') {
    const a = requireAdmin(req);
    const body = await readJsonBody(req);
    const sid = Number(body.sessionId);
    try {
      await session.cleanupSession(sid, { reason: `limpeza administrativa por ${a.user.username}` });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof session.SessionError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  if (sub === 'sunshine' && method === 'GET') {
    requireAdmin(req);
    const info = await sunshine.readServerInfo();
    return sendJson(res, 200, { sunshine: info });
  }
  if (sub === 'sunshine/sync' && method === 'POST') {
    requireAdmin(req);
    const r = await sunshine.ensureSunshineRunning();
    const info = await sunshine.readServerInfo();
    return sendJson(res, 200, { sync: r, sunshine: info });
  }
  if (sub === 'sunshine/credentials' && method === 'POST') {
    requireAdmin(req);
    const body = await readJsonBody(req);
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      throw new HttpError(400, 'credenciais do Sunshine ausentes');
    }
    sunshine.setSunshineCredentials(body.username, body.password);
    return sendJson(res, 200, { ok: true });
  }
  if (sub === 'events' && method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, { events: db.listEvents(200) });
  }
  if (sub === 'attempts' && method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, { attempts: db.listRecentAttempts(50) });
  }
  if (sub === 'compatibility' && method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, compatibilityReport());
  }

  throw new HttpError(404, 'rota administrativa não encontrada');
}

function publicState() {
  const m = db.getMachine();
  const open = db.anyOpenSession();
  return {
    machine: {
      state: m.state,
      detail: m.state_detail,
      sessionId: m.session_id,
      updatedAt: m.updated_at,
    },
    hasOpenSession: !!open,
    version: '0.1.0',
  };
}

// ---- Servidor ---------------------------------------------------------------

async function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // Prevenir traversal: normaliza e confina em PUBLIC_DIR.
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'acesso negado' });
  }
  try {
    const st = await stat(full);
    if (st.isDirectory()) throw new Error('dir');
    const data = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    return sendJson(res, 404, { error: 'não encontrado' });
  }
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else if (req.method === 'GET') {
        await serveStatic(res, url.pathname);
      } else {
        sendJson(res, 405, { error: 'método não permitido' });
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) {
        db.logEvent('error', 'erro interno', { path: url.pathname, msg: e.message });
      }
      sendJson(res, status, { error: e.message });
    }
  });
}

export { loadConfig };
