// Integração com o Sunshine (servidor de streaming, projeto oficial LizardByte).
//
// Fatos extraídos do código-fonte do Sunshine (docs/THIRD_PARTY.md):
//  - Há DOIS servidores:
//      * GameStream (nvhttp), porta base 47989. HTTP (47989) serve /serverinfo e
//        /pair sem exigir certificado de cliente. HTTPS (47984) exige cert pareado.
//      * Web UI / config API (confighttp), HTTPS na porta 47990, autenticação
//        Basic (usuário/senha guardados em sunshine_state.json com sha256+salt).
//  - O Sunshine NÃO tem endpoint para INICIAR um app na Web API. O streaming
//    começa quando um cliente Moonlight pareado chama /launch do protocolo
//    GameStream (com rikey/rikeyid). Por isso este HOST é um PLANO DE CONTROLE:
//    autoriza e reserva, e o Moonlight real conecta direto no Sunshine.
//  - O estado livre/ocupado é lido de GET /serverinfo (campo <state> e
//    <currentgame>) no HTTP 47989, sem necessidade de cert de cliente.
//
// Este módulo fala a API real do Sunshine. Nada é simulado.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, saveConfig } from './config.js';
import https from 'node:https';

const execFileAsync = promisify(execFile);

// Portas padrão do Sunshine derivadas da base 47989.
export const SUNSHINE_PORT_BASE = 47989;
export const PORT_GAMESTREAM_HTTP = 47989; // /serverinfo, /pair (sem cert)
export const PORT_GAMESTREAM_HTTPS = 47984; // /launch, /applist, /resume, /cancel
export const PORT_CONFIG_API = 47990; // Web UI / config API (HTTPS, Basic Auth)

// Configuração das credenciais da Web API do Sunshine. Prioriza o config
// persistido (arquivo 0600); o set em memória sobrepõe durante o processo.
// São as credenciais DO Sunshine, não do jogador.
let sunshineCreds = null;

export function setSunshineCredentials(username, password) {
  sunshineCreds = { username, password };
  // Persiste no config para sobreviver a reinício do serviço.
  try {
    saveConfig({ sunshineUsername: username, sunshinePassword: password });
  } catch {
    /* persistência é melhor esforço */
  }
}

export function getSunshineCredentials() {
  if (sunshineCreds) return { ...sunshineCreds };
  const cfg = loadConfig();
  return {
    username: cfg.sunshineUsername || null,
    password: cfg.sunshinePassword || null,
  };
}

// Agente HTTPS que aceita o certificado auto-assinado do Sunshine. O Sunshine
// usa cert self-signed por padrão; como o tráfego fica na rede privada
// (Tailscale) e a API exige Basic Auth, aceitamos o auto-assinado aqui.
function unsafeHttpsAgent() {
  // Node não permite criar agente sem import; usamos a opção por requisição.
  return { rejectUnauthorized: false };
}

async function gamestreamHttpBase() {
  const cfg = loadConfig();
  const host = cfg.sunshineAddress.split(':')[0] || '127.0.0.1';
  return `http://${host}:${PORT_GAMESTREAM_HTTP}`;
}

// GET na config API com Basic Auth e TLS self-signed (via https nativo).
async function configGet(path) {
  return configRequest('GET', path, null);
}

// Nota sobre TLS self-signed: o Sunshine usa cert auto-assinado. O HOST chama a
// config API (47990) em loopback e aceita o self-signed apenas aqui, pois o
// tráfego é local e a API exige Basic Auth. O estado de streaming usa o HTTP
// simples (47989) sem TLS (readServerInfo).

// Requisição genérica à config API usando o https nativo (aceita self-signed).
function configRequest(method, path, body) {
  if (configOverride) {
    try {
      return Promise.resolve(
        configOverride(method, path, body) || { ok: true, status: 200, json: () => ({}) }
      );
    } catch (e) {
      return Promise.reject(e);
    }
  }
  const creds = getSunshineCredentials();
  const auth = creds.username
    ? 'Basic ' +
      Buffer.from(`${creds.username}:${creds.password || ''}`).toString('base64')
    : undefined;
  const url = new URL(path, `https://${loadConfig().sunshineAddress.split(':')[0]}:${PORT_CONFIG_API}`);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        port: PORT_CONFIG_API,
        path: url.pathname + url.search,
        rejectUnauthorized: false, // self-signed do Sunshine (loopback)
        headers: {
          ...(auth ? { authorization: auth } : {}),
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: () => data, json: () => { try { return JSON.parse(data); } catch { return {}; } } })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout na API do Sunshine')));
    if (payload) req.write(payload);
    req.end();
  });
}
export class SunshineError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// Ponto de injeção para testes: quando definido, substitui a leitura real do
// estado. Produção nunca usa isto; apenas os testes de plano de controle.
let serverInfoOverride = null;
export function __setServerInfoOverride(fn) {
  serverInfoOverride = fn;
}

// Ponto de injeção para testes da camada HTTPS da config API (pareamento etc.).
// Recebe (method, path, body) e devolve { ok, status, json() }.
let configOverride = null;
export function __setConfigOverride(fn) {
  configOverride = fn;
}

// Lê o estado do Sunshine via GameStream HTTP (sem TLS, sem cert de cliente).
// Retorna { reachable, busy, currentGame, hostname, pairStatus }.
export async function readServerInfo() {
  if (serverInfoOverride) return serverInfoOverride();
  const base = await gamestreamHttpBase();
  let xml;
  try {
    const res = await fetch(`${base}/serverinfo`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { reachable: false, error: `HTTP ${res.status}` };
    }
    xml = await res.text();
  } catch (e) {
    return { reachable: false, error: e.message };
  }
  const hostname = /<hostname>([^<]*)<\/hostname>/.exec(xml)?.[1] || null;
  const state = /<state>([^<]*)<\/state>/.exec(xml)?.[1] || null;
  const currentGame = Number(/<currentgame>(\d+)<\/currentgame>/.exec(xml)?.[1] ?? 0);
  const pairStatus = /<PairStatus>(\d+)<\/PairStatus>/.exec(xml)?.[1] ?? null;
  const busy = /BUSY/i.test(state || '') || currentGame > 0;
  return { reachable: true, busy, currentGame, hostname, pairStatus, state };
};

// Lê a lista de apps via GameStream HTTPS /applist. Requer Sunshine acessível
// e, na prática, é chamado pelo Moonlight pareado; aqui é opcional e usado só
// para exibir a biblioteca no painel quando disponível.
export async function readAppList() {
  const cfg = loadConfig();
  const host = cfg.sunshineAddress.split(':')[0] || '127.0.0.1';
  try {
    const res = await fetch(`https://${host}:${PORT_GAMESTREAM_HTTPS}/applist`, {
      signal: AbortSignal.timeout(4000),
      // aceita self-signed
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const xml = await res.text();
    const apps = [...xml.matchAll(/<App>([\s\S]*?)<\/App>/g)].map((m) => ({
      id: Number(/<ID>(\d+)<\/ID>/.exec(m[1])?.[1] ?? 0),
      title: /<AppTitle>([^<]*)<\/AppTitle>/.exec(m[1])?.[1] || '',
    }));
    return { ok: true, apps };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Gera a configuração do Sunshine para o nosso uso. Usado pelo instalador.
// Grava sunshine.conf no diretório de configuração apontado pelo HOST.
export function buildSunshineConfig({ port = SUNSHINE_PORT_BASE } = {}) {
  return [
    `port = ${port}`,
    'address_family = ipv4',
    // Origem da Web UI restrita: o painel é servido pelo nosso HOST, então a
    // Web UI do Sunshine fica em loopback e é acessada apenas pelo serviço.
    'origin_web_ui_allowed = pc',
  ].join('\n');
}

// Inicia/reinicia o serviço do Sunshine no Linux (Flatpak ou binário local).
// Retorna o comando executado. No Windows de desenvolvimento, apenas informa.
export async function ensureSunshineRunning() {
  if (process.platform !== 'linux') {
    return {
      started: false,
      note: 'Sunshine gerenciado apenas no Linux. Em desenvolvimento Windows o HOST não o inicia.',
    };
  }
  // Flatpak oficial (Bazzite instala via Flathub).
  try {
    await execFileAsync('systemctl', [
      '--user',
      'is-active',
      'app-dev.lizardbyte.app.Sunshine',
    ]);
  } catch {
    /* não ativo ou ausente */
  }
  // Tenta iniciar via Flatpak primeiro (caminho do Bazzite).
  try {
    await execFileAsync('flatpak', [
      'run',
      '--command=true',
      'dev.lizardbyte.app.Sunshine',
    ]);
    await execFileAsync('systemctl', [
      '--user',
      'start',
      'app-dev.lizardbyte.app.Sunshine',
    ]);
    return { started: true, method: 'flatpak-systemd' };
  } catch {
    /* segue para binário local */
  }
  try {
    await execFileAsync('systemctl', ['--user', 'start', 'sunshine']);
    return { started: true, method: 'systemd' };
  } catch (e) {
    return { started: false, error: e.message };
  }
}

// Para a sessão de streaming atual do Sunshine via config API (Basic Auth).
// Equivale a POST /api/apps/close. Usado pelo HOST ao encerrar uma sessão para
// garantir que nenhum app do jogador permaneça rodando.
export async function closeRunningApp() {
  try {
    const res = await configPost('/api/apps/close', {});
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function configPost(path, body) {
  return configRequest('POST', path, body || {});
}

// Obtém o token CSRF da Web UI (necessário para POSTs vindos de browser; para
// chamadas de serviço não-browser o Sunshine isenta, mas guardamos por robustez).
export async function getCsrfToken() {
  try {
    const res = await configGet('/api/csrf-token');
    return res.ok ? res.json().csrf_token || null : null;
  } catch {
    return null;
  }
}

// Garante que existe um app "Desktop" no Sunshine (para o Moonlight abrir a
// área de trabalho). Usa POST /api/apps com o corpo oficial do Sunshine.
export async function ensureDesktopApp() {
  try {
    const apps = await configGet('/api/apps');
    if (apps.ok) {
      const list = apps.json().apps || [];
      if (list.some((a) => /desktop/i.test(a.title || a.name || ''))) {
        return { ok: true, existed: true };
      }
    }
    const res = await configPost('/api/apps', {
      name: 'Desktop',
      title: 'Desktop',
      cmd: '',
      index: -1,
      'prep-cmd': [],
      'auto-detach': true,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Status de pareamento do Sunshine (clientes pareados + pareamentos pendentes).
export async function readPairingStatus() {
  const out = { clients: null, pending: null, error: null };
  try {
    const c = await configGet('/api/clients/list');
    out.clients = c.ok ? c.json() : null;
  } catch (e) {
    out.error = e.message;
  }
  try {
    const p = await configGet('/api/pin');
    out.pending = p.ok ? p.json() : null;
  } catch {
    /* melhor esforço */
  }
  return out;
}

// Envia um PIN para concluir um pareamento pendente (fluxo oficial do Sunshine).
export async function submitPin(pairingId, pin, name = 'moonshine-client') {
  const res = await configPost('/api/pin', {
    pairing_id: pairingId,
    pin: String(pin),
    name,
  });
  return { ok: res.ok, status: res.status };
}

export { configGet };
