// Código de convite "online" — autossuficiente para o modo online embutido.
//
// Problema que resolve: o APP do jogador precisa estar na rede privada
// (Tailscale) para alcançar o HOST (100.x), mas a chave da rede vinha do
// HOST — que só é alcançável DEPOIS de entrar na rede. O convite resolve o
// pega-eto carregando em si o que o app precisa para entrar sozinho:
// token do convite + endereço do HOST na rede + chave de autenticação.
//
// Formato v1 (binário, depois base32 de Crockford, prefixo MS1-):
//   byte 0        : versão (1)
//   byte 1        : comprimento do token (10)
//   token         : 10 bytes brutos do código clássico XXXXX-XXXXX
//   4 bytes       : IPv4 do HOST na rede privada
//   byte          : comprimento da chave (0..255)
//   chave         : chave de autenticação (ASCII)
//   byte          : comprimento da URL de controle (0 = padrão do Tailscale)
//   url           : URL de controle alternativa (ASCII)
//
// Segurança: o código online É a credencial (mesmo modelo do código clássico)
// e agora também transporta a chave da rede — o dono deve usar tag/expiração
// no Tailscale e tratar o código como segredo (ver SECURITY.md). Revogar o
// convite corta o resgate; revogar/rotacionar a chave corta a rede.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // base32 de Crockford
const MAP = new Map();
for (let i = 0; i < ALPHABET.length; i++) MAP.set(ALPHABET[i], i);
// Tolerância visual de Crockford: I/L → 1, O → 0 (o U é proibido).
MAP.set('I', 1);
MAP.set('L', 1);
MAP.set('O', 0);

export const ONLINE_CODE_PREFIX = 'MS1-';

// Os 10 símbolos do código clássico "XXXXX-XXXXX" como valores 0..31
// (10 × 5 bits = 50 bits de entropia; NÃO é byte-align — por isso guardamos
// os valores dos símbolos, não bytes decodificados).
export function classicTokenSymbols(code) {
  const clean = String(code || '').toUpperCase().replace(/-/g, '');
  if (clean.length !== 10) return null;
  const out = new Uint8Array(10);
  let o = 0;
  for (const ch of clean) {
    const v = MAP.get(ch);
    if (v === undefined) return null;
    out[o++] = v;
  }
  return o === 10 ? out : null;
}

// base32 de Crockford (bytes → símbolos), sem agrupamento.
function b32encode(buf) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of buf) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function b32decode(str) {
  const clean = String(str || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0');
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = MAP.get(ch);
    if (v === undefined) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function group(s) {
  return (s.match(/.{1,5}/g) || []).join('-');
}

// Gera o código online a partir do código clássico + dados da rede.
// Retorna null quando não há dados suficientes (sem chave ou sem IPv4).
export function encodeOnlineCode({ classicCode, hostIpv4, authKey, controlUrl = '' }) {
  const token = classicTokenSymbols(classicCode);
  const ip = String(hostIpv4 || '').trim();
  const key = String(authKey || '').trim();
  if (!token || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !key || key.length > 255) return null;
  const ctrl = String(controlUrl || '').trim();
  if (ctrl.length > 255) return null;
  const ipBytes = ip.split('.').map((n) => Number(n) & 0xff);
  const payload = Buffer.concat([
    Buffer.from([1, 10]),
    token,
    Buffer.from(ipBytes),
    Buffer.from([key.length]),
    Buffer.from(key, 'utf8'),
    Buffer.from([ctrl.length]),
    Buffer.from(ctrl, 'utf8'),
  ]);
  return ONLINE_CODE_PREFIX + group(b32encode(payload));
}

// Decodifica um código online. Retorna { token, hostIpv4, authKey, controlUrl }
// ou null se não for um código online válido.
export function decodeOnlineCode(code) {
  const raw = String(code || '').trim();
  if (!raw.toUpperCase().startsWith(ONLINE_CODE_PREFIX)) return null;
  const buf = b32decode(raw.slice(ONLINE_CODE_PREFIX.length));
  if (!buf || buf.length < 4) return null;
  let p = 0;
  if (buf[p++] !== 1) return null;
  const tokenLen = buf[p++];
  if (tokenLen !== 10 || buf.length < p + tokenLen + 4 + 1) return null;
  const tokenBuf = buf.subarray(p, p + tokenLen);
  p += tokenLen;
  // Cada byte do token deve ser um símbolo base32 válido (0..31).
  for (const v of tokenBuf) if (v > 31) return null;
  const hostIpv4 = `${buf[p]}.${buf[p + 1]}.${buf[p + 2]}.${buf[p + 3]}`;
  p += 4;
  const keyLen = buf[p++];
  if (keyLen > 0 && buf.length < p + keyLen + 1) return null;
  const authKey = buf.subarray(p, p + keyLen).toString('utf8');
  p += keyLen;
  const ctrlLen = buf[p++];
  if (buf.length < p + ctrlLen) return null;
  const controlUrl = buf.subarray(p, p + ctrlLen).toString('utf8');
  // O token volta ao formato clássico XXXXX-XXXXX (usado pelo resgate).
  let token = '';
  for (const v of tokenBuf) token += ALPHABET[v & 31];
  return { token: group(token), hostIpv4, authKey, controlUrl };
}

// Extrai o token de um código (clássico ou online) para o resgate.
export function extractToken(code) {
  const dec = decodeOnlineCode(code);
  if (dec) return dec.token;
  const clean = String(code || '').toUpperCase().replace(/-/g, '');
  if (clean.length === 10 && classicTokenSymbols(code)) return group(clean);
  return null;
}
