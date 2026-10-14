// Carregamento e validação da configuração do HOST.
//
// A configuração vive em data/config.json e é criada com valores padrão
// seguros na primeira execução. Nenhum segredo é gravado aqui em texto claro:
// hashes de senha e tokens ficam no banco (db.js).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Raiz do projeto (dois níveis acima de host/src).
export const PROJECT_ROOT = join(here, '..', '..');

// Diretório de dados local. Sob Bazzite fica sob a home do serviço; em
// desenvolvimento usa ./data na raiz do projeto.
export const DATA_DIR =
  process.env.MOONSHINE_DATA_DIR || join(PROJECT_ROOT, 'data');

export const DEFAULT_CONFIG = {
  // Porta da API de controle. Fica atrás do Tailscale Serve na implantação
  // real; em desenvolvimento escuta em 127.0.0.1.
  // 48100 e NÃO 47990: 47990 é a Web UI do Sunshine (base 47989 + 1) e os dois
  // serviços rodam na mesma máquina — na mesma porta um falharia ao escutar.
  port: Number(process.env.MOONSHINE_PORT || 48100),
  bindHost: process.env.MOONSHINE_BIND || '127.0.0.1',

  // Endereço do Sunshine usado pelo cliente Moonlight para streaming.
  // Em produção é o IP Tailscale do HOST na porta 47989 (HTTPS do Sunshine).
  sunshineAddress: process.env.MOONSHINE_SUNSHINE_ADDR || '127.0.0.1:47989',

  // Credenciais da Web UI do Sunshine (para a config API em 47990). Guardadas
  // neste arquivo com permissão 0600. São credenciais DO Sunshine, não do
  // jogador. A senha da Steam nunca é coletada.
  sunshineUsername: process.env.MOONSHINE_SUNSHINE_USER || '',
  sunshinePassword: process.env.MOONSHINE_SUNSHINE_PASS || '',

  // Diretório de configuração do Sunshine para gestão.
  sunshineConfigDir:
    process.env.MOONSHINE_SUNSHINE_CONFIG || join(DATA_DIR, 'sunshine'),

  // Aplicativo padrão iniciado pelo Sunshine quando a sessão sobe.
  streamAppName: 'Desktop',

  // Política de isolamento (ver isolation.js):
  //  - 'dedicated-user': cria/usuário dedicado por sessão no Linux (forte)
  //  - 'temp-home': usa um HOME temporário para o usuário dedicado
  //  - 'none': sem isolamento de SO (somente desenvolvimento/teste Windows)
  isolationMode: process.env.MOONSHINE_ISOLATION || 'dedicated-user',

  // Usuário Linux dedicado criado/uso para as sessões de jogadores.
  dedicatedUserPrefix: 'msplayer',

  // Raiz de dados temporários de sessão (descartável).
  sessionRuntimeDir:
    process.env.MOONSHINE_SESSION_RUNTIME || '/var/tmp/moonshine-sessions',

  // Biblioteca permanente de jogos autorizada (somente leitura para o jogador).
  gameLibraryDir:
    process.env.MOONSHINE_GAME_LIBRARY || join(DATA_DIR, 'library'),

  // Bloqueio de login por força bruta.
  loginMaxAttempts: 5,
  loginLockoutMs: 15 * 60 * 1000,

  // Validade de um token de sessão de cliente.
  tokenTtlMs: 12 * 60 * 60 * 1000,

  // Tempo máximo (ms) que o HOST espera a limpeza antes de marcar erro
  // permanente e manter a máquina bloqueada.
  cleanupTimeoutMs: 90 * 1000,
};

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof base[k] === 'object' &&
      base[k] !== null &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let cached = null;

export function configPath() {
  return join(DATA_DIR, 'config.json');
}

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  mkdirSync(DATA_DIR, { recursive: true });
  const p = configPath();
  let user = {};
  if (existsSync(p)) {
    try {
      user = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(
        `config.json inválido em ${p}: ${e.message}. Corrija ou remova o arquivo.`
      );
    }
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  validateConfig(cfg);
  if (!existsSync(p)) {
    // Persiste os padrões para facilitar a administração posterior.
    writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  cached = cfg;
  return cfg;
}

export function saveConfig(patch) {
  const cfg = loadConfig({ reload: true });
  const next = deepMerge(cfg, patch || {});
  validateConfig(next);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  cached = next;
  return next;
}

export function validateConfig(cfg) {
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`porta inválida: ${cfg.port}`);
  }
  if (typeof cfg.bindHost !== 'string' || !cfg.bindHost) {
    throw new Error('bindHost inválido');
  }
  if (!/^[a-z0-9-]+$/.test(cfg.dedicatedUserPrefix)) {
    throw new Error('dedicatedUserPrefix deve ser [a-z0-9-]');
  }
  if (!['dedicated-user', 'temp-home', 'none'].includes(cfg.isolationMode)) {
    throw new Error(`isolationMode inválido: ${cfg.isolationMode}`);
  }
  return true;
}
