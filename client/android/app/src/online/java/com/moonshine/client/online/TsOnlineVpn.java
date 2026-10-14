package com.moonshine.client.online;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * VPN privada embutida — Tailscale REAL via libtailscale (biblioteca oficial,
 * repositório tailscale/tailscale-android, licença BSD-3).
 *
 * Fluxo de subida:
 * 1. Libtailscale.start() sobe o backend Go (estado em files/tailscale);
 * 2. o serviço MoonshineVpnService sobe em primeiro plano e pede o túnel
 *    (Libtailscale.requestVPN) — o VpnService do Android fornece o TUN sem root;
 * 3. POST /localapi/v0/start com a AuthKey do convite online loga sem
 *    interação nenhuma no control plane do Tailscale;
 * 4. polling de GET /localapi/v0/status até BackendState=Running e TUN=true.
 *
 * A partir daí o Moonlight embutido alcança o Sunshine do HOST em100.x —
 * o código de streaming NÃO muda em nada.
 */
public final class TsOnlineVpn implements OnlineVpn {

    private static final TsOnlineVpn INSTANCE = new TsOnlineVpn();

    public static OnlineVpn get() {
        return INSTANCE;
    }

    /** Chamado pelo serviço quando o túnel sobe/desce (via UpdateVpnStatus). */
    static void onTunnelStatus(boolean active) {
        synchronized (INSTANCE.lock) {
            INSTANCE.tunnelUp = active;
        }
    }

    private final Object lock = new Object();
    private libtailscale.Application app;
    private Context appCtx;
    private boolean tunnelUp = false;
    private Listener pending;
    private String pendingKey = "";
    private String pendingCtrl = "";

    private TsOnlineVpn() {
    }

    @Override
    public boolean isSupported() {
        return Build.VERSION.SDK_INT >= 26;
    }

    @Override
    public boolean isReady() {
        synchronized (lock) {
            return tunnelUp && app != null;
        }
    }

    @Override
    public void ensureOnline(Context ctx, String authKey, String controlUrl, Listener l) {
        if (!isSupported()) {
            l.onError("Modo online requer Android 8.0 ou superior.");
            return;
        }
        final Context c = ctx.getApplicationContext();
        final String key = authKey == null ? "" : authKey;
        final String ctrl = controlUrl == null ? "" : controlUrl;
        synchronized (lock) {
            appCtx = c;
            if (app == null) {
                String dir = new java.io.File(c.getFilesDir(), "tailscale").getAbsolutePath();
                //noinspection ResultOfMethodCallIgnored
                new java.io.File(dir).mkdirs();
                app = libtailscale.Libtailscale.start(dir, dir, false, new TsAppContext(c));
            }
            pending = l;
            pendingKey = key;
            pendingCtrl = ctrl;
            if (tunnelUp) {
                l.onReady();
                return;
            }
        }
        Intent consent = VpnService.prepare(c);
        if (consent != null) {
            l.onConsentNeeded(consent);
            return;
        }
        startTunnel(c, key, ctrl, l);
    }

    @Override
    public void onConsentResult(Context ctx, int resultCode) {
        Listener l;
        String key;
        String ctrl;
        synchronized (lock) {
            l = pending;
            key = pendingKey;
            ctrl = pendingCtrl;
        }
        if (l == null) {
            return;
        }
        if (resultCode != Activity.RESULT_OK) {
            l.onError("Permissão de VPN negada. O modo online precisa dela para alcançar o HOST.");
            return;
        }
        startTunnel(ctx.getApplicationContext(), key, ctrl, l);
    }

    private void startTunnel(final Context c, final String key, final String ctrl, final Listener l) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent(c, MoonshineVpnService.class);
                    if (Build.VERSION.SDK_INT >= 26) {
                        c.startForegroundService(i);
                    } else {
                        c.startService(i);
                    }
                    String err = loginAndWait(key, ctrl, 90_000);
                    if (err != null) {
                        post(l, false, err);
                        return;
                    }
                    post(l, true, null);
                } catch (Exception e) {
                    post(l, false, "Falha ao subir a rede privada: " + e.getMessage());
                }
            }
        }, "moonshine-ts-vpn").start();
    }

    /** Envia a chave para o control plane e espera o túnel ficar pronto. */
    private String loginAndWait(String key, String ctrl, long timeoutMs) throws Exception {
        JSONObject body = new JSONObject();
        body.put("AuthKey", key);
        JSONObject prefsJson = new JSONObject();
        prefsJson.put("WantRunning", true);
        prefsJson.put("RouteAll", false); // só a rede100.x passa pelo túnel
        if (!ctrl.isEmpty()) {
            prefsJson.put("ControlURL", ctrl);
        }
        body.put("UpdatePrefs", prefsJson);
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

        libtailscale.LocalAPIResponse r =
                app.callLocalAPI(20_000, "POST", "/localapi/v0/start", new TsInputStream(payload));
        if (r == null) {
            return "o serviço da rede privada não respondeu";
        }
        if (r.statusCode() >= 400) {
            return "a rede privada recusou a chave (HTTP " + r.statusCode() + "): " + bodyText(r);
        }

        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(700);
            libtailscale.LocalAPIResponse s = null;
            try {
                s = app.callLocalAPI(8_000, "GET", "/localapi/v0/status", null);
            } catch (Exception ignore) {
                // tenta de novo no próximo ciclo
            }
            if (s == null || s.statusCode() >= 400) {
                continue;
            }
            JSONObject j = new JSONObject(bodyText(s));
            String bs = j.optString("BackendState", "");
            if ("Running".equals(bs) && j.optBoolean("TUN", false)) {
                return null;
            }
            if ("NeedsLogin".equals(bs) || "Stopped".equals(bs) || "NeedsMachineAuth".equals(bs)) {
                return "a rede privada pediu login interativo — gere uma chave nova no painel do HOST";
            }
        }
        return "tempo esgotado esperando a rede privada (confira a internet do aparelho)";
    }

    private static String bodyText(libtailscale.LocalAPIResponse r) {
        try {
            byte[] b = r.bodyBytes();
            return b == null ? "" : new String(b, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private void post(final Listener l, final boolean ok, final String err) {
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                if (ok) {
                    l.onReady();
                } else {
                    l.onError(err);
                }
            }
        });
    }

    @Override
    public void disconnect() {
        final Context c;
        synchronized (lock) {
            c = appCtx;
        }
        if (c == null) {
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (app != null) {
                        app.callLocalAPI(6_000, "POST", "/localapi/v0/logout", null);
                    }
                } catch (Throwable ignore) {
                    // melhor esforço
                }
                try {
                    c.stopService(new Intent(c, MoonshineVpnService.class));
                } catch (Throwable ignore) {
                    // melhor esforço
                }
                synchronized (lock) {
                    tunnelUp = false;
                }
            }
        }, "moonshine-ts-off").start();
    }

    /**
     * Corpo de requisição em memória para o CallLocalAPI (interface InputStream
     * do libtailscale: read() devolve o próximo pedaço; array vazio = fim).
     */
    static final class TsInputStream implements libtailscale.InputStream {
        private final byte[] data;
        private int pos = 0;

        TsInputStream(byte[] data) {
            this.data = data;
        }

        @Override
        public byte[] read() {
            if (pos >= data.length) {
                return new byte[0]; // fim do corpo
            }
            int n = Math.min(4_096, data.length - pos);
            byte[] chunk = new byte[n];
            System.arraycopy(data, pos, chunk, 0, n);
            pos += n;
            return chunk;
        }

        @Override
        public void close() {
        }
    }
}
