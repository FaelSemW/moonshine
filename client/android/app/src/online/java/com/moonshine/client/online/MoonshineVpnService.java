package com.moonshine.client.online;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.IpPrefix;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;

import java.io.IOException;
import java.util.UUID;

/**
 * Serviço VPN que hospeda o túnel Tailscale REAL (libtailscale oficial).
 *
 * O backend Go pede o túnel via Libtailscale.requestVPN(this) e monta tudo por
 * meio dos callbacks abaixo: rotas100.x, MTU, DNS e o descritor do arquivo
 * TUN (via VpnService.Builder — sem root, sem driver). Depois disso o app
 * inteiro, incluindo o Moonlight embutido, alcança o HOST em100.x.
 */
public class MoonshineVpnService extends VpnService implements libtailscale.IPNService {

    private static final String CHANNEL_ID = "moonshine_vpn";
    private static final int NOTIFY_ID = 42;

    private final String randomId = UUID.randomUUID().toString();

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch =
                    new NotificationChannel(CHANNEL_ID, "Rede privada", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Moonshine: túnel da rede privada do anfitrião");
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                .setContentTitle("Moonshine")
                .setContentText("Rede privada do anfitrião ativa")
                .setOngoing(true)
                .build();
        startForeground(NOTIFY_ID, n);
        try {
            libtailscale.Libtailscale.requestVPN(this);
        } catch (Throwable t) {
            // Backend pode ainda estar inicializando; TsOnlineVpn re-pede ao dar login.
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return super.onBind(intent); // exigido para BIND_VPN_SERVICE
    }

    @Override
    public void onDestroy() {
        try {
            libtailscale.Libtailscale.serviceDisconnect(this);
        } catch (Throwable ignore) {
            // backend já finalizado
        }
        super.onDestroy();
    }

    // ---- libtailscale.IPNService ------------------------------------------

    @Override
    public String id() {
        return randomId;
    }

    // protect(int) é herdado de VpnService (public boolean protect(int fd)).

    @Override
    public libtailscale.VPNServiceBuilder newBuilder() {
        return new TsVpnBuilder(new Builder());
    }

    @Override
    public void close() {
        stopSelf();
    }

    @Override
    public void disconnectVPN() {
        stopSelf();
    }

    @Override
    public void updateVpnStatus(boolean active) {
        TsOnlineVpn.onTunnelStatus(active);
    }

    // ---- wrappers entregues ao backend Go ---------------------------------

    static final class TsVpnBuilder implements libtailscale.VPNServiceBuilder {
        private final VpnService.Builder b;

        TsVpnBuilder(VpnService.Builder b) {
            this.b = b;
        }

        @Override
        public void setMTU(int mtu) throws Exception {
            b.setMtu(mtu);
        }

        @Override
        public void addDNSServer(String addr) throws Exception {
            b.addDnsServer(addr);
        }

        @Override
        public void addSearchDomain(String domain) throws Exception {
            b.addSearchDomain(domain);
        }

        @Override
        public void addRoute(String addr, int prefix) throws Exception {
            b.addRoute(addr, prefix);
        }

        @Override
        public void addAddress(String addr, int prefix) throws Exception {
            b.addAddress(addr, prefix);
        }

        @Override
        public void excludeRoute(String addr, int prefix) throws Exception {
            if (Build.VERSION.SDK_INT >= 33) {
                b.excludeRoute(new IpPrefix(addr + "/" + prefix));
            }
            // Abaixo de API33 não há excludeRoute, mas com RouteAll=false o
            // túnel recebe só as rotas100.x — nada do aparelho é capturado.
        }

        @Override
        public ParcelFileDescriptor establish() throws Exception {
            ParcelFileDescriptor pfd = b.establish();
            if (pfd == null) {
                throw new IOException("VPN não estabelecida (cancelada pelo sistema)");
            }
            return new TsParcelFileDescriptor(pfd);
        }
    }

    static final class TsParcelFileDescriptor implements libtailscale.ParcelFileDescriptor {
        private final ParcelFileDescriptor pfd;

        TsParcelFileDescriptor(ParcelFileDescriptor pfd) {
            this.pfd = pfd;
        }

        @Override
        public int detach() throws Exception {
            return pfd.detachFd();
        }
    }
}
