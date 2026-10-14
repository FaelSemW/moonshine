package com.moonshine.client;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Cliente da API de controle do HOST Moonshine.
 *
 * Fala com o servidor real do host (node host/src/server.js): login, estado da
 * máquina, reservar/preparar/encerrar sessão e heartbeat. Não há dependências
 * externas: usa apenas java.net.HttpURLConnection e org.json, ambos do Android.
 *
 * Todos os métodos são BLOQUEANTES — chame em uma thread em segundo plano
 * (nunca na main thread; o Android lança NetworkOnMainThreadException).
 */
public final class HostApi {

    /** Erro da API carregando o status HTTP (para distinguir 401/409/403). */
    public static class ApiException extends Exception {
        public final int status;

        public ApiException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private String baseUrl;
    private String token;

    public HostApi(String baseUrl) {
        setBaseUrl(baseUrl);
    }

    public void setBaseUrl(String baseUrl) {
        String b = baseUrl == null ? "" : baseUrl.trim();
        while (b.endsWith("/")) {
            b = b.substring(0, b.length() - 1);
        }
        this.baseUrl = b;
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setToken(String token) {
        this.token = token;
    }

    public String getToken() {
        return token;
    }

    public boolean hasToken() {
        return token != null && !token.isEmpty();
    }

    // ---- operações do painel de controle ---------------------------------

    /** POST /api/login — guarda o token Bearer em memória. */
    public void login(String username, String password) throws Exception {
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        JSONObject r = new JSONObject(post("/api/login", body));
        token = r.getString("token");
    }

    /**
     * POST /api/redeem — entra com um código de convite (sem senha). O código é a
     * credencial enviada pelo operador. Guarda o token e devolve a resposta
     * completa { token, user, mode } — o modo concedido é "game" (sessão isolada)
     * ou "full" (PC completo).
     */
    public JSONObject redeem(String code) throws Exception {
        JSONObject body = new JSONObject();
        body.put("code", code);
        JSONObject r = new JSONObject(post("/api/redeem", body));
        token = r.getString("token");
        return r;
    }

    /**
     * POST /api/pair/pin — auto-pareamento: o PIN é GERADO por este lado (fluxo
     * oficial do GameStream) e enviado ao HOST, que o repassa ao Sunshine. O
     * jogador nunca digita o PIN.
     */
    public JSONObject submitPairPin(String pin, String deviceName) throws Exception {
        JSONObject body = new JSONObject();
        body.put("pin", pin);
        if (deviceName != null && !deviceName.isEmpty()) {
            body.put("name", deviceName);
        }
        return new JSONObject(post("/api/pair/pin", body));
    }

    /** GET /api/state → { machine: { state, detail, sessionId, updatedAt }, ... } */
    public JSONObject state() throws Exception {
        return new JSONObject(get("/api/state"));
    }

    /** POST /api/session/reserve → { sessionId, resumed, state } (409 se ocupada). */
    public JSONObject reserve() throws Exception {
        return new JSONObject(post("/api/session/reserve", new JSONObject()));
    }

    /** POST /api/session/prepare → { sessionId, state, streamTarget, ... } */
    public JSONObject prepare(long sessionId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("sessionId", sessionId);
        return new JSONObject(post("/api/session/prepare", body));
    }

    /** POST /api/session/heartbeat → mantém a sessão viva. */
    public JSONObject heartbeat(long sessionId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("sessionId", sessionId);
        return new JSONObject(post("/api/session/heartbeat", body));
    }

    /** POST /api/session/end → encerra e dispara a limpeza no host. */
    public void end(long sessionId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("sessionId", sessionId);
        post("/api/session/end", body);
    }

    /** POST /api/logout — revoga o token atual (melhor esforço). */
    public void logout() {
        try {
            post("/api/logout", new JSONObject());
        } catch (Exception ignore) {
            // O token é local; falhar não tem efeito colateral.
        }
        token = null;
    }

    // ---- transporte ------------------------------------------------------

    private String get(String path) throws Exception {
        return request("GET", path, null);
    }

    private String post(String path, JSONObject body) throws Exception {
        return request("POST", path, body);
    }

    private String request(String method, String path, JSONObject body) throws Exception {
        URL url = new URL(baseUrl + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(20000);
            if (hasToken()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(payload.length);
                OutputStream os = conn.getOutputStream();
                try {
                    os.write(payload);
                } finally {
                    os.close();
                }
            }

            int status = conn.getResponseCode();
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(is);

            if (status >= 400) {
                String msg = text;
                try {
                    JSONObject j = new JSONObject(text);
                    if (j.has("error")) {
                        msg = j.getString("error");
                    }
                } catch (Exception ignore) {
                    // Corpo não é JSON; usa o texto bruto.
                }
                throw new ApiException(
                        status, msg == null || msg.isEmpty() ? ("HTTP " + status) : msg);
            }
            return text;
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
        try {
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line);
            }
        } finally {
            br.close();
        }
        return sb.toString();
    }
}
