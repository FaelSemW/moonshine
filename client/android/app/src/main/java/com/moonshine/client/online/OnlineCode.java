package com.moonshine.client.online;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Código de convite "online" (MS1-...) — versão autossuficiente gerada pelo
 * HOST (host/src/onlinecode.js). Carrega, em um único campo colável:
 * token do convite + endereço IPv4 do HOST na rede privada + chave de
 * autenticação da rede + URL de controle opcional.
 *
 * Isso resolve o pega-eto do modo online: o APP precisa estar na rede privada
 * (Tailscale,100.x) para alcançar o HOST, mas a chave vinha do próprio HOST.
 * Com o código online, o app entra na rede PRIMEIRO e só depois fala com o
 * HOST — o amigo instala apenas o app Moonshine.
 *
 * Layout v1 (bytes antes do base32 de Crockford, prefixo "MS1-"):
 *   byte 0        : versão (1)
 *   byte 1        : comprimento do token (10)
 *   10 bytes      : valores dos símbolos do token (0..31 cada)
 *   4 bytes       : IPv4 do HOST na rede privada
 *   byte + N      : comprimento e bytes UTF-8 da chave de autenticação
 *   byte + M      : comprimento e bytes UTF-8 da URL de controle (0 = padrão)
 */
public final class OnlineCode {

    public static final String PREFIX = "MS1-";

    /** Alfabeto base32 de Crockford (sem I/L/O/U visuais). */
    private static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /** Token no formato clássico XXXXX-XXXXX (usado no resgate). */
    public final String token;
    /** IPv4 do HOST na rede privada (ex.:100.64.0.9). */
    public final String hostIpv4;
    /** Chave de autenticação da rede (vazio se o código não trouxe chave). */
    public final String authKey;
    /** URL de controle alternativa (vazio = padrão do Tailscale). */
    public final String controlUrl;

    private OnlineCode(String token, String hostIpv4, String authKey, String controlUrl) {
        this.token = token;
        this.hostIpv4 = hostIpv4;
        this.authKey = authKey;
        this.controlUrl = controlUrl;
    }

    /** Decodifica um código online; devolve null se não for um válido. */
    public static OnlineCode parse(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim().toUpperCase();
        if (!s.startsWith(PREFIX)) {
            return null;
        }
        StringBuilder clean = new StringBuilder();
        for (int i = PREFIX.length(); i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')) {
                clean.append(c);
            }
        }
        byte[] b = decodeBits(clean.toString());
        if (b == null || b.length < 18) {
            return null;
        }
        int p = 0;
        if (b[p++] != 1) {
            return null; // versão desconhecida
        }
        int tokenLen = b[p++] & 0xff;
        if (tokenLen != 10 || b.length < p + 10 + 4 + 1) {
            return null;
        }
        StringBuilder token = new StringBuilder();
        for (int i = 0; i < 10; i++) {
            int v = b[p + i] & 0xff;
            if (v > 31) {
                return null; // símbolo inválido no token
            }
            token.append(ALPHABET.charAt(v));
        }
        token.insert(5, '-');
        p += 10;
        String host = (b[p] & 0xff) + "." + (b[p + 1] & 0xff) + "."
                + (b[p + 2] & 0xff) + "." + (b[p + 3] & 0xff);
        p += 4;
        int keyLen = b[p++] & 0xff;
        if (b.length < p + keyLen + 1) {
            return null;
        }
        String key = new String(b, p, keyLen, StandardCharsets.UTF_8);
        p += keyLen;
        int ctrlLen = b[p++] & 0xff;
        if (b.length < p + ctrlLen) {
            return null;
        }
        String ctrl = new String(b, p, ctrlLen, StandardCharsets.UTF_8);
        return new OnlineCode(token.toString(), host, key, ctrl);
    }

    /** Valor de um símbolo Crockford (tolerante a I/L→1 e O→0; U proibido). */
    private static int symbolValue(char c) {
        if (c == 'I' || c == 'L') {
            return 1;
        }
        if (c == 'O') {
            return 0;
        }
        return ALPHABET.indexOf(c); // -1 quando inválido
    }

    /** Decodifica símbolos base32 (5 bits) em bytes (8 bits), MSB primeiro. */
    private static byte[] decodeBits(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int acc = 0;
        int bits = 0;
        for (int i = 0; i < s.length(); i++) {
            int v = symbolValue(s.charAt(i));
            if (v < 0) {
                return null;
            }
            acc = (acc << 5) | v;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                out.write((acc >> bits) & 0xff);
            }
        }
        return out.toByteArray();
    }

    /** true se o host está no intervalo CGNAT100.64/10 usado pela rede Tailscale. */
    public static boolean isPrivateNetHost(String host) {
        if (host == null) {
            return false;
        }
        String[] o = host.split("\\.");
        if (o.length != 4) {
            return false;
        }
        try {
            return Integer.parseInt(o[0]) == 100
                    && Integer.parseInt(o[1]) >= 64
                    && Integer.parseInt(o[1]) <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
