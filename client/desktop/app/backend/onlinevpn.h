#ifndef ONLINEVPN_H
#define ONLINEVPN_H

#include <QNetworkAccessManager>
#include <QObject>
#include <QString>
#include <QStringList>

#include <functional>

// VPN privada do modo online: dirige o cliente OFICIAL do Tailscale para o
// amigo entrar na rede do anfitrião (100.x) ANTES de resgatar/streamar. No
// Windows, se o Tailscale não existir no PC, baixa o MSI oficial assinado e
// instala com uma elevação UAC (o jogador não configura nada à mão).
//
// Com o TUN ativo, 100.x é roteado normalmente — o código de streaming do
// Moonlight não muda nada. Fora do Windows v1 é melhor esforço: usa um
// `tailscale` encontrado no PATH, sem download e sem elevação interativa.
class OnlineVpn : public QObject
{
    Q_OBJECT

public:
    static OnlineVpn* instance();

    // Windows: sempre true (dá para baixar/instalar). Outros SO: true
    // apenas se achar o binário `tailscale` no PATH.
    bool isSupported() const;

    bool isReady() const { return m_ready; }

    // Garante a rede privada com a chave informada. cb é chamado na thread
    // principal (main), com ok=true quando a rede estiver pronta. Se já
    // estiver pronta, responde imediatamente.
    void ensureOnline(const QString& authKey, const QString& controlUrl,
                      std::function<void(bool ok, const QString& err)> cb);

    // Sai da rede privada — somente se fomos nós quem entrou (nunca derruba
    // uma sessão Tailscale que o usuário já tinha neste PC).
    void disconnect();

signals:
    // Progresso em PT-BR para a UI ("Procurando o Tailscale...", ...).
    void statusChanged(const QString& text);

private:
    explicit OnlineVpn(QObject* parent = nullptr);

    // Saída de um comando, esperado com loop de eventos aninhado (a UI
    // continua viva enquanto o processo roda).
    struct ProcResult {
        bool started = false;  // o processo chegou a rodar
        bool timedOut = false; // estourou o timeout e foi morto
        int exitCode = -1;
        QString out;
        QString err;
    };

    // Estado lido de `tailscale status --json`.
    struct TsState {
        bool reachable = false; // o CLI respondeu
        bool running = false;   // BackendState == "Running"
        bool online = false;    // Self.Online
    };

    QString findCli() const;
    ProcResult run(const QString& exe, const QStringList& args, int timeoutMs) const;
    TsState queryState(const QString& cli) const;
    bool downloadMsi(QString* msiPath, QString* err);
    bool verifySignature(const QString& msiPath, QString* err);
    bool installMsi(const QString& msiPath, QString* err);

    QNetworkAccessManager m_nam;
    QString m_cli;      // caminho do tailscale usado
    bool m_busy = false;
    bool m_ready = false;
    // true só quando o login na rede foi feito POR NÓS (quem permite logout).
    bool m_oursLoggedIn = false;
};

#endif // ONLINEVPN_H
