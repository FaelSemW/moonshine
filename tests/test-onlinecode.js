import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeOnlineCode,
  decodeOnlineCode,
  extractToken,
  classicTokenSymbols,
} from '../host/src/onlinecode.js';

test('código online: roundtrip token + IPv4 + chave + URL de controle', () => {
  const classic = 'MN3PQ-RTVWX';
  const code = encodeOnlineCode({
    classicCode: classic,
    hostIpv4: '100.64.0.9',
    authKey: 'tskey-auth-abc123',
    controlUrl: 'https://hs.example:8080',
  });
  assert.ok(code.startsWith('MS1-'), `prefixo: ${code}`);
  const d = decodeOnlineCode(code);
  assert.equal(d.token, classic);
  assert.equal(d.hostIpv4, '100.64.0.9');
  assert.equal(d.authKey, 'tskey-auth-abc123');
  assert.equal(d.controlUrl, 'https://hs.example:8080');
});

test('código online sem URL de controle (padrão do Tailscale)', () => {
  const code = encodeOnlineCode({
    classicCode: 'MN3PQ-RTVWX',
    hostIpv4: '100.101.102.103',
    authKey: 'tskey-auth-x',
  });
  const d = decodeOnlineCode(code);
  assert.equal(d.hostIpv4, '100.101.102.103');
  assert.equal(d.controlUrl, '');
  assert.equal(d.token, 'MN3PQ-RTVWX');
});

test('codificação rejeita dados incompletos/inválidos', () => {
  const base = { hostIpv4: '100.64.0.9', authKey: 'tskey-auth-k' };
  assert.equal(encodeOnlineCode({ ...base, classicCode: 'curto' }), null);
  assert.equal(encodeOnlineCode({ ...base, classicCode: 'MN3PQ-RTVWX', hostIpv4: 'nao-ip' }), null);
  assert.equal(
    encodeOnlineCode({ classicCode: 'MN3PQ-RTVWX', hostIpv4: '100.64.0.9', authKey: '' }),
    null
  );
  assert.equal(
    encodeOnlineCode({ classicCode: 'MN3PQ-RTVWX', hostIpv4: '100.64.0.9', authKey: 'k'.repeat(256) }),
    null
  );
});

test('decodificação defensiva: clássico, lixo, truncamento', () => {
  assert.equal(decodeOnlineCode('MN3PQ-RTVWX'), null); // clássico não é online
  assert.equal(decodeOnlineCode('MS1-AAAA'), null); // payload curto
  assert.equal(decodeOnlineCode('MS1-@#!$%'), null); // símbolos inválidos
  assert.equal(decodeOnlineCode(''), null);
  const ok = encodeOnlineCode({
    classicCode: 'MN3PQ-RTVWX',
    hostIpv4: '100.64.0.9',
    authKey: 'tskey-auth-longo',
  });
  assert.equal(decodeOnlineCode(ok.slice(0, ok.length - 4)), null); // truncado
});

test('extractToken aceita os dois formatos', () => {
  assert.equal(extractToken('MN3PQ-RTVWX'), 'MN3PQ-RTVWX');
  const on = encodeOnlineCode({
    classicCode: 'MN3PQ-RTVWX',
    hostIpv4: '100.64.0.9',
    authKey: 'k',
  });
  assert.equal(extractToken(on), 'MN3PQ-RTVWX');
  assert.equal(extractToken('XX'), null);
});

test('símbolos do token clássico são validados (tolerante a caixa)', () => {
  assert.equal(classicTokenSymbols('MN3PQ-RTVWX')?.length, 10);
  assert.equal(classicTokenSymbols('mn3pq-rtvwx')?.length, 10);
  assert.equal(classicTokenSymbols('ABC'), null);
  assert.equal(classicTokenSymbols('ABCDE-FGHIU'), null); // U proibido no Crockford
  assert.equal(classicTokenSymbols('ABCDE-FGHIJK'), null); // comprimento 11
});
