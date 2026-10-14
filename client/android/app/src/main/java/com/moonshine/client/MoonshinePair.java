package com.moonshine.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import com.limelight.nvstream.http.PairingManager;

/**
 * Auto-pareamento Moonshine.
 *
 * O PIN do pareamento GameStream é GERADO pelo cliente (este app). Em vez de
 * exibi-lo para o jogador digitar na Web UI do Sunshine, instalamos um submissor
 * no PairingManager do Moonlight embutido: ele entrega o PIN ao HOST Moonshine
 * (POST /api/pair/pin com a sessão do jogador), e o HOST o repassa à API oficial
 * do Sunshine (POST /api/pin). O jogador não digita nada.
 *
 * Ativo somente quando há sessão Moonshine (token); sem sessão, o PairingManager
 * segue o fluxo oficial manual.
 */
public final class MoonshinePair {

    private MoonshinePair() {
    }

    /**
     * True quando o app tem sessão Moonshine (token salvo) — é o gatilho do
     * pareamento automático na tela de pareamento.
     *
     * @param context contexto para ler o SharedPreferences compartilhado.
     * @return true = parear automaticamente; false = fluxo oficial com PIN na tela.
     */
    public static boolean isAutoEnabled(Context context) {
        SharedPreferences prefs = context.getSharedPreferences("moonshine", Context.MODE_PRIVATE);
        String token = prefs.getString("token", null);
        return token != null && !token.isEmpty();
    }

    /**
     * Instala no PairingManager do Moonlight embutido o submissor que leva o PIN
     * ao HOST. Chamar uma vez (MainActivity.onCreate); o submissor lê URL/token
     * frescos do SharedPreferences a cada pareamento.
     *
     * @param context contexto da aplicação (é usado apenas para ler preferências).
     */
    public static void install(final Context context) {
        final SharedPreferences prefs =
                context.getApplicationContext().getSharedPreferences("moonshine", Context.MODE_PRIVATE);
        PairingManager.setPinSubmitter(pin -> {
            if (!isAutoEnabled(context)) {
                // Sem sessão Moonshine: deixa o fluxo manual (diálogo) cuidar.
                return;
            }
            HostApi api = new HostApi(prefs.getString("url", ""));
            api.setToken(prefs.getString("token", null));
            // Bloqueante: roda na thread de pareamento do PcView (nunca na main).
            api.submitPairPin(pin, (Build.MANUFACTURER + " " + Build.MODEL).trim());
        });
    }
}
