package com.moonshine.client.online;

import android.content.Context;
import android.content.Intent;

/**
 * Fachada da VPN privada embutida (Tailscale REAL, incorporado oficialmente
 * via libtailscale — mesma biblioteca do app do Tailscale).
 *
 * A implementação concreta (TsOnlineVpn) só existe quando o APK é compilado
 * com o AAR em app/libs/libtailscale.aar — gerado no CI a partir do repositório
 * oficial tailscale/tailscale-android (BSD-3). Sem o AAR, create() devolve null
 * e o modo online fica indisponível, com aviso honesto na tela.
 */
public interface OnlineVpn {

    /** Retornos assíncronos do ciclo de subida da VPN. */
    interface Listener {
        /** Rede privada pronta (túnel ativo e backend "Running"). */
        void onReady();

        /** O sistema exige consentimento do usuário (primeira vez). */
        void onConsentNeeded(Intent consentIntent);

        /** Falha com mensagem humana (chave recusada, timeout, sem APK com VPN...). */
        void onError(String message);
    }

    /**
     * Cria a instância da VPN embutida via reflexão (a classe concreta só
     * existe nos APKs compilados com o AAR do Tailscale). Null quando ausente.
     */
    static OnlineVpn create() {
        try {
            Class<?> c = Class.forName("com.moonshine.client.online.TsOnlineVpn");
            return (OnlineVpn) c.getDeclaredMethod("get").invoke(null);
        } catch (Throwable t) {
            return null;
        }
    }

    boolean isSupported();

    /** true quando o túnel privado já está ativo neste processo. */
    boolean isReady();

    /**
     * Garante a rede privada com a chave informada. Chama onReady quando
     * pronta; pode pedir consentimento (onConsentNeeded → chamar
     * onConsentResult com o resultado da Activity).
     */
    void ensureOnline(Context ctx, String authKey, String controlUrl, Listener l);

    /** Resultado do consentimento de VPN (Activity.RESULT_*). */
    void onConsentResult(Context ctx, int resultCode);

    /** Sai da rede privada e derruba o túnel (melhor esforço). */
    void disconnect();
}
