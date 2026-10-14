package com.moonshine.client;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.limelight.computers.ComputerManagerService;
import com.limelight.nvstream.http.ComputerDetails;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Tela de controle do Moonshine no Android (o "app do jogador").
 *
 * Este é o ponto de entrada do APK. Faz o fluxo real contra o HOST Moonshine
 * (host/src/server.js): login → reservar sessão → preparar sessão → heartbeat →
 * encerrar. Depois registra o Sunshine no Moonlight embutido (ComputerManagerService)
 * e abre o PcView do MESMO APK, onde o usuário pareia (1ª vez) e inicia o streaming.
 *
 * Nada aqui simula vídeo: o stream real é feito pelo código Moonlight que já roda
 * dentro deste mesmo aplicativo.
 */
public class MainActivity extends Activity {

    private HostApi api;
    private SharedPreferences prefs;
    private ExecutorService exec;
    private Handler main;

    private EditText etUrl, etUser, etPass;
    private TextView tvStatus;
    private LinearLayout loginGroup, actionGroup;
    private Button btnLogin, btnPlay, btnEnd, btnLogout;

    private long sessionId = 0;
    private String streamHost;
    private int streamPort = 47989;

    private final Runnable hbTick = new Runnable() {
        @Override
        public void run() {
            doHeartbeat();
        }
    };

    // Integração com o Moonlight embutido (mesmo APK).
    private ComputerManagerService.ComputerManagerBinder moonBinder;
    private boolean moonBound = false;
    private String pendingHost;
    private int pendingPort;

    private final ServiceConnection moonConn = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            moonBinder = (ComputerManagerService.ComputerManagerBinder) service;
            moonBound = true;
            addHostAndLaunch();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            moonBinder = null;
            moonBound = false;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("moonshine", MODE_PRIVATE);
        api = new HostApi(prefs.getString("url", "http://192.168.0.10:48100"));
        exec = Executors.newSingleThreadExecutor();
        main = new Handler(Looper.getMainLooper());

        buildUi();

        String token = prefs.getString("token", null);
        String user = prefs.getString("user", null);
        if (token != null && user != null) {
            api.setToken(token);
            etUser.setText(user);
            setLoggedIn(true);
            status("Restaurando sessão...");
            refreshState();
        }
    }

    // ---- UI ---------------------------------------------------------------

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        root.setPadding(pad, pad, pad, pad);
        scroll.addView(root);
        setContentView(scroll);

        TextView title = new TextView(this);
        title.setText("Moonshine");
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Plataforma de cloud gaming · streaming embutido");
        sub.setTextSize(13);
        sub.setPadding(0, dp(4), 0, dp(16));
        root.addView(sub);

        etUrl = addField(root, "Endereço do HOST", api.getBaseUrl());
        etUrl.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);

        loginGroup = new LinearLayout(this);
        loginGroup.setOrientation(LinearLayout.VERTICAL);
        root.addView(loginGroup);

        etUser = addField(loginGroup, "Usuário", prefs.getString("user", ""));
        etPass = addField(loginGroup, "Senha", "");
        etPass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        btnLogin = addButton(loginGroup, "Entrar", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                login();
            }
        });

        actionGroup = new LinearLayout(this);
        actionGroup.setOrientation(LinearLayout.VERTICAL);
        actionGroup.setVisibility(View.GONE);
        root.addView(actionGroup);

        tvStatus = new TextView(this);
        tvStatus.setTextSize(14);
        tvStatus.setPadding(0, dp(16), 0, dp(8));
        actionGroup.addView(tvStatus);

        btnPlay = addButton(actionGroup, "Jogar (reservar sessão)", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                play();
            }
        });
        btnEnd = addButton(actionGroup, "Encerrar sessão", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                endSession();
            }
        });
        btnLogout = addButton(actionGroup, "Sair", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                logout();
            }
        });

        setLoggedIn(false);
    }

    private EditText addField(LinearLayout parent, String label, String value) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextSize(13);
        LinearLayout.LayoutParams tlp =
                new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = dp(10);
        tv.setLayoutParams(tlp);
        parent.addView(tv);

        EditText et = new EditText(this);
        et.setText(value);
        et.setSingleLine(true);
        parent.addView(et);
        return et;
    }

    private Button addButton(LinearLayout parent, String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp =
                new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        parent.addView(b);
        return b;
    }

    private void setLoggedIn(boolean loggedIn) {
        loginGroup.setVisibility(loggedIn ? View.GONE : View.VISIBLE);
        actionGroup.setVisibility(loggedIn ? View.VISIBLE : View.GONE);
    }

    // ---- ações ------------------------------------------------------------

    private void login() {
        final String url = etUrl.getText().toString().trim();
        final String user = etUser.getText().toString().trim();
        final String pass = etPass.getText().toString();
        if (url.isEmpty() || user.isEmpty() || pass.isEmpty()) {
            toast("Preencha endereço, usuário e senha.");
            return;
        }
        api.setBaseUrl(url);
        btnLogin.setEnabled(false);
        status("Entrando...");
        exec.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    api.login(user, pass);
                    prefs.edit()
                            .putString("url", url)
                            .putString("user", user)
                            .putString("token", api.getToken())
                            .apply();
                    runUi(new Runnable() {
                        @Override
                        public void run() {
                            btnLogin.setEnabled(true);
                            setLoggedIn(true);
                            status("Conectado como " + user + ".");
                            refreshState();
                        }
                    });
                } catch (final Exception e) {
                    runUi(new Runnable() {
                        @Override
                        public void run() {
                            btnLogin.setEnabled(true);
                            status("Falha no login: " + msg(e));
                        }
                    });
                }
            }
        });
    }

    private void refreshState() {
        exec.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject s = api.state();
                    JSONObject m = s.optJSONObject("machine");
                    String st = m != null ? m.optString("state", "?") : "?";
                    status("Máquina: " + st);
                } catch (HostApi.ApiException e) {
                    if (e.status == 401) {
                        localLogout();
                        status("Sessão expirada. Entre novamente.");
                    } else {
                        status("Erro: " + e.getMessage());
                    }
                } catch (Exception e) {
                    status("Erro: " + msg(e));
                }
            }
        });
    }

    private void play() {
        String url = etUrl.getText().toString().trim();
        if (!url.isEmpty() && !url.equals(api.getBaseUrl())) {
            api.setBaseUrl(url);
        }
        btnPlay.setEnabled(false);
        status("Reservando sessão...");
        exec.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject r = api.reserve();
                    final long sid = r.getLong("sessionId");
                    status("Preparando ambiente...");
                    JSONObject p = api.prepare(sid);
                    String target = p.optString("streamTarget", "");
                    sessionId = sid;
                    parseTarget(target);
                    prefs.edit().putString("token", api.getToken()).apply();
                    startHeartbeat();
                    runUi(new Runnable() {
                        @Override
                        public void run() {
                            btnPlay.setEnabled(true);
                            status("Sessão ativa. Conectando ao Sunshine ("
                                    + streamHost + ":" + streamPort + ")...");
                            bindMoonlight(streamHost, streamPort);
                        }
                    });
                } catch (HostApi.ApiException e) {
                    final String m =
                            e.status == 409 ? "PC ocupado por outro jogador." : "Erro: " + e.getMessage();
                    runUi(new Runnable() {
                        @Override
                        public void run() {
                            btnPlay.setEnabled(true);
                            status(m);
                        }
                    });
                } catch (final Exception e) {
                    runUi(new Runnable() {
                        @Override
                        public void run() {
                            btnPlay.setEnabled(true);
                            status("Erro: " + msg(e));
                        }
                    });
                }
            }
        });
    }

    private void endSession() {
        final long sid = sessionId;
        sessionId = 0;
        stopHeartbeat();
        if (sid <= 0) {
            status("Nenhuma sessão ativa.");
            return;
        }
        btnEnd.setEnabled(false);
        exec.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    api.end(sid);
                } catch (Exception ignore) {
                    // Melhor esforço; a limpeza também é disparada pelo heartbeat do host.
                }
                runUi(new Runnable() {
                    @Override
                    public void run() {
                        btnEnd.setEnabled(true);
                        status("Sessão encerrada. PC liberado.");
                        unbindMoon();
                    }
                });
            }
        });
    }

    private void logout() {
        final long sid = sessionId;
        sessionId = 0;
        stopHeartbeat();
        exec.execute(new Runnable() {
            @Override
            public void run() {
                if (sid > 0) {
                    try {
                        api.end(sid);
                    } catch (Exception ignore) {
                        // melhor esforço
                    }
                }
                api.logout();
                prefs.edit().remove("token").apply();
                runUi(new Runnable() {
                    @Override
                    public void run() {
                        unbindMoon();
                        setLoggedIn(false);
                        status("Saiu.");
                    }
                });
            }
        });
    }

    private void localLogout() {
        sessionId = 0;
        stopHeartbeat();
        api.setToken(null);
        prefs.edit().remove("token").apply();
        unbindMoon();
        setLoggedIn(false);
    }

    // ---- integração com o Moonlight embutido ------------------------------

    private void bindMoonlight(String host, int port) {
        pendingHost = host;
        pendingPort = port;
        if (moonBound && moonBinder != null) {
            addHostAndLaunch();
            return;
        }
        Intent i = new Intent(this, ComputerManagerService.class);
        try {
            bindService(i, moonConn, Context.BIND_AUTO_CREATE);
        } catch (Exception e) {
            status("Falha ao iniciar o serviço Moonlight: " + msg(e));
        }
    }

    private void addHostAndLaunch() {
        final ComputerManagerService.ComputerManagerBinder binder = moonBinder;
        final String host = pendingHost;
        final int port = pendingPort;
        if (binder == null) {
            status("Serviço Moonlight indisponível.");
            return;
        }
        status("Adicionando host " + host + ":" + port + "...");
        exec.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    binder.waitForReady();
                    ComputerDetails details = new ComputerDetails();
                    details.manualAddress = new ComputerDetails.AddressTuple(host, port);
                    binder.addComputerBlocking(details);
                    runUi(new Runnable() {
                        @Override
                        public void run() {
                            launchPcView();
                        }
                    });
                } catch (final Exception e) {
                    runUi(new Runnable() {
                        @Override
                        public void run() {
                            status("Falha ao adicionar host: " + msg(e));
                        }
                    });
                }
            }
        });
    }

    private void launchPcView() {
        try {
            Intent i = new Intent();
            i.setClassName(getPackageName(), "com.limelight.PcView");
            startActivity(i);
            status("Escolha o host e inicie o streaming (pareie na 1ª vez).");
        } catch (Exception e) {
            status("Erro ao abrir o Moonlight: " + msg(e));
        }
    }

    private void unbindMoon() {
        if (moonBound) {
            try {
                unbindService(moonConn);
            } catch (Exception ignore) {
                // já desvinculado
            }
            moonBound = false;
            moonBinder = null;
        }
    }

    // ---- heartbeat --------------------------------------------------------

    private void startHeartbeat() {
        main.removeCallbacks(hbTick);
        main.postDelayed(hbTick, 5000);
    }

    private void stopHeartbeat() {
        main.removeCallbacks(hbTick);
    }

    private void doHeartbeat() {
        if (sessionId <= 0) {
            return;
        }
        final long sid = sessionId;
        exec.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    api.heartbeat(sid);
                } catch (Exception e) {
                    status("Sessão perdida: " + msg(e));
                }
            }
        });
        main.postDelayed(hbTick, 5000);
    }

    // ---- utilidades -------------------------------------------------------

    private void parseTarget(String target) {
        streamHost = target == null ? "" : target;
        streamPort = 47989;
        if (target == null || target.isEmpty()) {
            return;
        }
        if (target.startsWith("[")) {
            int close = target.indexOf(']');
            if (close > 0) {
                streamHost = target.substring(1, close);
                if (close + 1 < target.length() && target.charAt(close + 1) == ':') {
                    try {
                        streamPort = Integer.parseInt(target.substring(close + 2));
                    } catch (Exception ignore) {
                        // porta inválida; mantém 47989
                    }
                }
            }
        } else {
            int ci = target.lastIndexOf(':');
            if (ci > 0) {
                streamHost = target.substring(0, ci);
                try {
                    streamPort = Integer.parseInt(target.substring(ci + 1));
                } catch (Exception ignore) {
                    // porta inválida; mantém 47989
                }
            }
        }
    }

    private void runUi(Runnable r) {
        main.post(r);
    }

    private void status(final String text) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (tvStatus != null) {
                    tvStatus.setText(text);
                }
            }
        });
    }

    private void toast(final String text) {
        main.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private String msg(Exception e) {
        String m = e.getMessage();
        return m == null ? e.getClass().getSimpleName() : m;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopHeartbeat();
        unbindMoon();
        final long sid = sessionId;
        sessionId = 0;
        if (sid > 0) {
            // Desliga a sessão no host se o app for fechado com sessão ativa.
            exec.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        api.end(sid);
                    } catch (Exception ignore) {
                        // melhor esforço
                    }
                }
            });
        }
        exec.shutdown();
    }
}
