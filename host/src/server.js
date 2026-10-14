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
import { randomBytes } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as db from './db.js';
import * as auth from './auth.js';
import * as session from './session.js';
import * as sunshine from './sunshine.js';
import { compatibilityReport, detectTailscale } from './probe.js';
import { loadConfig, saveConfig } from './config.js';

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

// Limitador simples em memória por chave — proteção contra força bruta em
// endpoints sensíveis (redeem), no mesmo espírito do lockout de login.
const rlBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const nowMs = Date.now();
  const b = rlBuckets.get(key);
  if (!b || nowMs - b.start >= windowMs) {
    rlBuckets.set(key, { start: nowMs, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

// Gera código de convite legível e de alta entropia: base32 de Crockford
// (sem I/L/O/U para evitar troca visual), 10 símbolos = 50 bits, formatado
// XXXXX-XXXXX. 32 símbolos divide 256, então bytes[i] % 32 não enviesa.
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function generateInviteCode() {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += INVITE_ALPHABET[bytes[i] % 32];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
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

  // Resgate de código de convite: o código É a credencial do jogador (enviada
  // por ele pelo operador). Concede um token carregando o MODO do convite.
  if (method === 'POST' && path === '/api/redeem') {
    const body = await readJsonBody(req);
    const { code } = body;
    if (typeof code !== 'string' || !code.trim()) {
      throw new HttpError(400, 'código ausente');
    }
    if (rateLimit(`redeem:${clientIp(req)}`, 20, 60_000)) {
      throw new HttpError(429, 'muitas tentativas. Aguarde um minuto.');
    }
    const invite = db.findInviteByCode(code.trim());
    if (!invite) {
      db.logEvent('warn', 'redeem de código inexistente', { ip: clientIp(req) });
      throw new HttpError(401, 'código inválido');
    }
    if (!invite.active) throw new HttpError(401, 'código revogado');
    if (invite.expires_at != null && invite.expires_at <= db.now()) {
      throw new HttpError(401, 'código expirado');
    }
    const user = db.findUserById(invite.user_id);
    if (!user || !user.active) throw new HttpError(401, 'código inválido');
    // Consome 1 uso de forma atômica (evita estourar max_uses sob corrida).
    if (!db.consumeInvite(invite.id)) {
      throw new HttpError(401, 'código esgotado ou inválido');
    }
    const mode = invite.mode === 'full' ? 'full' : 'game';
    const { token } = auth.issueToken(user.id, mode);
    db.logEvent('info', 'código resgatado', {
      inviteId: invite.id,
      userId: user.id,
      mode,
      ip: clientIp(req),
    });
    return sendJson(res, 200, {
      token,
      user: { id: user.id, username: user.username, role: user.role },
      mode,
    });
  }

  // Auto-pareamento: o app cliente (nosso Moonlight embutido) GERA o PIN e o
  // envia para cá; nós o repassamos ao Sunshine pela API oficial (POST /api/pin).
  // O jogador nunca digita nada — a "trava" do pareamento some para o usuário.
  if (method === 'POST' && path === '/api/pair/pin') {
    const a = requireAuth(req);
    const body = await readJsonBody(req);
    const pin = body && body.pin;
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      throw new HttpError(400, 'PIN deve ter exatamente 4 dígitos');
    }
    if (rateLimit(`pairpin:${clientIp(req)}`, 10, 60_000)) {
      throw new HttpError(429, 'muitas tentativas de pareamento. Aguarde um minuto.');
    }
    const status = await sunshine.readPairingStatus();
    if (status.pending == null) {
      // A API do Sunshine não respondeu (fora do ar ou credenciais erradas) —
      // dizer "sem pareamento pendente" aqui seria enganoso.
      throw new HttpError(
        502,
        'API do Sunshine indisponível — confira o Sunshine e as credenciais na aba Sunshine.'
      );
    }
    const pairings = status.pending.pairings || [];
    if (pairings.length === 0) {
      throw new HttpError(409, 'nenhum pareamento pendente no Sunshine');
    }
    // Correlaciona pelo endereço que abriu o pareamento (o mesmo cliente que nos
    // chamou); com um único pendente, usa ele. Vários sem match = ambíguo.
    let target = pairings.find((p) => p.address && p.address === clientIp(req));
    if (!target && pairings.length === 1) target = pairings[0];
    if (!target) {
      throw new HttpError(409, 'há vários pareamentos pendentes; repita o procedimento');
    }
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 64)
        : 'moonshine-client';
    const r = await sunshine.submitPin(target.id, pin, name);
    if (!r.ok) throw new HttpError(502, `Sunshine recusou o PIN (HTTP ${r.status})`);
    db.logEvent('info', 'pareamento concluído pelo app (auto-pair)', {
      pairingId: target.id,
      name,
      userId: a.user.id,
    });
    return sendJson(res, 200, { ok: true, pairingId: target.id });
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
      // O modo vem da permissão gravada no token (concedida no login/redeem),
      // não de entrada livre do cliente.
      const mode = a.tokenRow.mode === 'full' ? 'full' : 'game';
      const { session: s, resumed } = session.reserveSession(a.user, a.tokenRow.id, mode);
      return sendJson(res, 200, { sessionId: s.id, resumed, state: s.state, mode: s.mode });
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
        mode: r.mode,
        streamTarget: r.streamTarget,
        isolation: r.isolation,
        library: r.library,
        // Modo online embutido: credencial da rede privada para o APP subir a
        // VPN embutida e alcançar streamTarget (100.x). Só aqui, sob Bearer
        // de sessão ativa — nunca em estado público nem no painel.
        online: onlineConfig(),
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

  // ---- Códigos de convite (o jogador entra pelo código, não por senha) ----
  if (sub === 'invites' && method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, { invites: db.listInvites() });
  }
  if (sub === 'invites' && method === 'POST') {
    const a = requireAdmin(req);
    const body = await readJsonBody(req);
    const mode = body.mode === 'full' ? 'full' : 'game';
    const maxUses = Math.min(Math.max(Number(body.maxUses) || 1, 1), 1000);
    let expiresAt = null;
    if (body.expiresInMin != null && body.expiresInMin !== '') {
      const mins = Number(body.expiresInMin);
      if (!Number.isFinite(mins) || mins <= 0) throw new HttpError(400, 'validade inválida');
      expiresAt = db.now() + Math.round(mins * 60_000);
    }
    const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;

    // Jogador alvo: usa o informado ou cria um dedicado para este convite.
    let userId = body.userId != null && body.userId !== '' ? Number(body.userId) : null;
    let username = null;
    if (!userId) {
      const uname = `jogador-${generateInviteCode().replace(/-/g, '').slice(0, 6).toLowerCase()}`;
      if (db.findUserByName(uname)) throw new HttpError(409, 'usuário de convite já existe');
      // Senha aleatória nunca divulgada: a credencial do jogador é o código.
      const hash = auth.hashPassword(randomBytes(24).toString('base64url'));
      userId = db.createUser({ username: uname, passwordHash: hash, role: 'player' });
      username = uname;
    } else {
      const u = db.findUserById(userId);
      if (!u) throw new HttpError(404, 'usuário inexistente');
      username = u.username;
    }

    const code = generateInviteCode();
    const id = db.createInvite({ code, mode, userId, note, expiresAt, maxUses, createdBy: a.user.id });
    db.logEvent('info', 'convite criado', { inviteId: id, mode, userId, maxUses, expiresAt });
    return sendJson(res, 201, { ok: true, inviteId: id, code, mode, username, expiresAt, maxUses });
  }
  if (sub === 'invites/revoke' && method === 'POST') {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const id = Number(body.id);
    if (!db.getInvite(id)) throw new HttpError(404, 'convite inexistente');
    db.revokeInvite(id);
    db.logEvent('warn', 'convite revogado', { inviteId: id });
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
  if (sub === 'sunshine/pairing' && method === 'GET') {
    requireAdmin(req);
    const p = await sunshine.readPairingStatus();
    return sendJson(res, 200, { pairing: p });
  }
  if (sub === 'sunshine/pairing' && method === 'POST') {
    requireAdmin(req);
    const body = await readJsonBody(req);
    if (!/^\d{4}$/.test(String(body.pin || ''))) {
      throw new HttpError(400, 'PIN deve ter 4 dígitos');
    }
    if (typeof body.pairingId !== 'string' || !/^[0-9a-f]{16,64}$/i.test(body.pairingId)) {
      throw new HttpError(400, 'pairingId inválido');
    }
    const r = await sunshine.submitPin(body.pairingId, body.pin, body.name || 'moonshine');
    return sendJson(res, r.ok ? 200 : 502, r);
  }
  if (sub === 'sunshine/desktop-app' && method === 'POST') {
    requireAdmin(req);
    const r = await sunshine.ensureDesktopApp();
    return sendJson(res, r.ok ? 200 : 502, r);
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
  if (sub === 'network' && method === 'GET') {
    requireAdmin(req);
    const cfg = loadConfig();
    return sendJson(res, 200, {
      bindHost: cfg.bindHost,
      port: cfg.port,
      tailscale: detectTailscale(),
      sunshineAddress: cfg.sunshineAddress,
      // Modo online embutido: só a EXISTÊNCIA da chave — nunca o valor.
      online: { configured: !!cfg.tailscaleAuthKey, controlUrl: cfg.tailscaleControlUrl || null },
    });
  }
  if (sub === 'network' && method === 'POST') {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const patch = {};
    if (body.bindHost !== undefined) {
      if (typeof body.bindHost !== 'string' || !/^[\d.]{3,15}$|^[a-fA-F0-9:]{3,45}$|^[a-z0-9.-]{3,255}$/.test(body.bindHost)) {
        throw new HttpError(400, 'bindHost inválido');
      }
      patch.bindHost = body.bindHost;
    }
    if (body.sunshineAddress !== undefined) {
      if (typeof body.sunshineAddress !== 'string' || !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(body.sunshineAddress)) {
        throw new HttpError(400, 'endereço do Sunshine inválido (host:porta)');
      }
      patch.sunshineAddress = body.sunshineAddress;
    }
    // Modo online embutido: chave da rede privada (segredo do dono).
    if (body.tailscaleAuthKey !== undefined) {
      if (typeof body.tailscaleAuthKey !== 'string' || body.tailscaleAuthKey.length > 256) {
        throw new HttpError(400, 'chave da rede inválida (string até 256 caracteres)');
      }
      // Remove espaços de copiar/colar; string vazia desativa o modo online.
      patch.tailscaleAuthKey = body.tailscaleAuthKey.trim();
    }
    if (body.tailscaleControlUrl !== undefined) {
      const v = String(body.tailscaleControlUrl).trim();
      if (v && !/^https?:\/\/[A-Za-z0-9.:-]{3,255}$/.test(v)) {
        throw new HttpError(400, 'URL de controle inválida (http(s)://host[:porta])');
      }
      patch.tailscaleControlUrl = v;
    }
    const needsRestart = patch.bindHost !== undefined || patch.port !== undefined;
    if (Object.keys(patch).length) saveConfig(patch);
    const cfg = loadConfig({ reload: true });
    // Nunca ecoar segredos (senha do Sunshine, chave da rede): só a visão
    // segura que o painel precisa.
    return sendJson(res, 200, {
      ok: true,
      requiresRestart: needsRestart,
      view: {
        bindHost: cfg.bindHost,
        port: cfg.port,
        sunshineAddress: cfg.sunshineAddress,
        online: { configured: !!cfg.tailscaleAuthKey, controlUrl: cfg.tailscaleControlUrl || null },
      },
    });
  }

  throw new HttpError(404, 'rota administrativa não encontrada');
}

// Credencial do modo online embutido (VPN Tailscale dentro dos apps). A chave
// É o acesso à rede privada do dono: entregue somente em prepare, sob Bearer
// de sessão ativa. O painel admin nunca recebe o valor (só "configurada") e a
// chave não é logada. O dono gera/revoga no admin do Tailscale.
function onlineConfig() {
  const cfg = loadConfig();
  if (!cfg.tailscaleAuthKey) return null;
  return { authKey: cfg.tailscaleAuthKey, controlUrl: cfg.tailscaleControlUrl || null };
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
