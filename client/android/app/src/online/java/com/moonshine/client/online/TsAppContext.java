package com.moonshine.client.online;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileDescriptor;
import java.lang.reflect.Field;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;
import java.util.List;

/**
 * Ponte entre o backend Go do Tailscale (libtailscale oficial) e o Android.
 * O Go chama estes métodos para ler o ambiente do aparelho (interfaces,
 * DNS, nome do dispositivo) e para guardar o estado do ipn.
 *
 * Contrato de JSON das interfaces (libtailscale/ifaceparse):
 * [{name,index,mtu,up,broadcast,loopback,pointToPoint,multicast,
 *   addrs:[{ip,prefixLen}]}]
 */
final class TsAppContext implements libtailscale.AppContext {

    private static final String TAG = "MoonshineTS";

    private final Context ctx;
    private final SharedPreferences prefs;

    TsAppContext(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = this.ctx.getSharedPreferences("moonshine_ts_bridge", Context.MODE_PRIVATE);
    }

    @Override
    public void log(String tag, String logLine) {
        Log.d("TS/" + tag, logLine);
    }

    // Estado do ipn: pequeno e já dentro do sandbox privado do app —
    // SharedPreferences privado cumpre o papel do "keystore encriptado".
    @Override
    public void encryptToPref(String key, String value) throws Exception {
        prefs.edit().putString(key, value).apply();
    }

    @Override
    public String decryptFromPref(String key) throws Exception {
        String v = prefs.getString(key, "");
        return v == null ? "" : v;
    }

    @Override
    public String getStateStoreKeysJSON() {
        return "[]";
    }

    @Override
    public String getOSVersion() throws Exception {
        return Build.VERSION.RELEASE;
    }

    @Override
    public long getSDKInt() throws Exception {
        return Build.VERSION.SDK_INT;
    }

    @Override
    public String getDeviceName() throws Exception {
        try {
            String n = Settings.Secure.getString(ctx.getContentResolver(), "device_name");
            if (n != null && !n.isEmpty()) {
                return n;
            }
        } catch (Throwable ignore) {
            // sem acesso ao settings; cai no modelo
        }
        return Build.MODEL != null ? Build.MODEL : "android";
    }

    @Override
    public String getInstallSource() {
        return "com.moonshine.client";
    }

    @Override
    public boolean shouldUseGoogleDNSFallback() {
        return false;
    }

    @Override
    public boolean isChromeOS() throws Exception {
        return false;
    }

    // Sem envio de logs de diagnóstico ao Tailscale (privacidade do jogador).
    @Override
    public boolean isClientLoggingEnabled() throws Exception {
        return false;
    }

    @Override
    public String getInterfacesAsJson() throws Exception {
        JSONArray ifaces = new JSONArray();
        Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
        while (en.hasMoreElements()) {
            NetworkInterface nif = en.nextElement();
            JSONObject o = new JSONObject();
            o.put("name", nif.getName());
            o.put("index", nif.getIndex());
            try {
                o.put("mtu", nif.getMTU());
            } catch (Throwable t) {
                o.put("mtu", 0);
            }
            o.put("up", nif.isUp());
            // Android não expõe supportsBroadcast(); o parser Go aceita false.
            o.put("broadcast", false);
            o.put("loopback", nif.isLoopback());
            o.put("pointToPoint", nif.isPointToPoint());
            o.put("multicast", nif.supportsMulticast());
            JSONArray addrs = new JSONArray();
            Enumeration<InetAddress> addrsEn = nif.getInetAddresses();
            while (addrsEn.hasMoreElements()) {
                InetAddress a = addrsEn.nextElement();
                JSONObject aj = new JSONObject();
                aj.put("ip", stripZone(a.getHostAddress()));
                aj.put("prefixLen", prefixLen(nif, a));
                addrs.put(aj);
            }
            o.put("addrs", addrs);
            ifaces.put(o);
        }
        return ifaces.toString();
    }

    /** IPv6 vem com zona (%wlan0) do Java; o parser Go não a espera. */
    private static String stripZone(String ip) {
        if (ip == null) {
            return "";
        }
        int pct = ip.indexOf('%');
        return pct >= 0 ? ip.substring(0, pct) : ip;
    }

    private static int prefixLen(NetworkInterface nif, InetAddress a) {
        try {
            // No Android getInterfaceAddresses() devolve List (não Enumeration).
            List<InterfaceAddress> e = nif.getInterfaceAddresses();
            for (InterfaceAddress ia : e) {
                if (ia.getAddress().equals(a)) {
                    return ia.getNetworkPrefixLength();
                }
            }
        } catch (Throwable ignore) {
            // cai no padrão
        }
        return a instanceof Inet6Address ? 128 : 32;
    }

    @Override
    public String getPlatformDNSConfig() {
        // Sem DNS dividido por app: o streaming usa IP puro (100.x), não nomes.
        return "";
    }

    @Override
    public String getSyspolicyStringValue(String key) throws Exception {
        throw new Exception("política não definida");
    }

    @Override
    public boolean getSyspolicyBooleanValue(String key) throws Exception {
        throw new Exception("política não definida");
    }

    @Override
    public String getSyspolicyStringArrayJSONValue(String key) throws Exception {
        throw new Exception("política não definida");
    }

    @Override
    public boolean hardwareAttestationKeySupported() {
        return false;
    }

    @Override
    public String hardwareAttestationKeyCreate() throws Exception {
        throw new Exception("não suportado");
    }

    @Override
    public void hardwareAttestationKeyRelease(String id) throws Exception {
        throw new Exception("não suportado");
    }

    @Override
    public byte[] hardwareAttestationKeyPublic(String id) throws Exception {
        throw new Exception("não suportado");
    }

    @Override
    public byte[] hardwareAttestationKeySign(String id, byte[] data) throws Exception {
        throw new Exception("não suportado");
    }

    @Override
    public void hardwareAttestationKeyLoad(String id) throws Exception {
        throw new Exception("não suportado");
    }

    @Override
    public boolean bindSocketToNetwork(int fd) {
        // Mantém os sockets do Tailscale na rede ativa do aparelho (fora do túnel).
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(ConnectivityManager.class);
            if (cm == null) {
                return false;
            }
            Network net = cm.getActiveNetwork();
            if (net == null) {
                return false;
            }
            FileDescriptor fdObj = new FileDescriptor();
            Field f = FileDescriptor.class.getDeclaredField("descriptor");
            f.setAccessible(true);
            f.setInt(fdObj, fd);
            net.bindSocket(fdObj);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    public byte[] getUserCACertsPEM() throws Exception {
        return new byte[0];
    }
}
