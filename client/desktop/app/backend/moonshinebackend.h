#ifndef MOONSHINEBACKEND_H
#define MOONSHINEBACKEND_H

#include <QObject>
#include <QNetworkAccessManager>
#include <QString>

#include <functional>

class QTimer;

// Controle da plataforma Moonshine no cliente desktop (Windows/Linux).
//
// Fala a API real do HOST (host/src/server.js): login, reservar, preparar,
// heartbeat e encerrar sessão. Depois do "prepare", o fluxo reutiliza as telas
// já existentes do Moonlight (PcView → AppView → StreamSegue → Session) para o
// streaming real, tudo dentro do MESMO executável. Nada aqui simula vídeo.
class MoonshineBackend : public QObject
{
    Q_OBJECT

public:
    explicit MoonshineBackend(QObject* parent = nullptr);

    Q_INVOKABLE void login(const QString& baseUrl,
                           const QString& username,
                           const QString& password);
    // Entra com CÓDIGO DE CONVITE (a credencial enviada pelo operador, sem senha).
    // A resposta traz o modo concedido: "game" (sessão isolada) ou "full" (PC
    // completo); fica exposto em grantedMode para a UI e o fluxo de streaming.
    Q_INVOKABLE void redeem(const QString& baseUrl, const QString& code);
    Q_INVOKABLE void play();
    Q_INVOKABLE void endSession();
    Q_INVOKABLE void logout();

    // "true" enquanto há sessão Moonshine (token) — é o gatilho do pareamento
    // automático: o PIN vai ao HOST em vez de aparecer em diálogo (auto-pair).
    Q_PROPERTY(bool autoPair READ autoPair NOTIFY autoPairChanged)

    QString grantedMode() const { return m_grantedMode; }
    bool autoPair() const { return !m_token.isEmpty(); }

signals:
    void loginFinished(bool ok, const QString& error);
    void redeemFinished(bool ok, const QString& mode, const QString& error);
    void grantedModeChanged();
    void autoPairChanged();
    void playFinished(bool ok, const QString& streamHost, int streamPort,
                      const QString& error);
    void statusChanged(const QString& text);
    void sessionEnded();

private:
    using ReplyCallback = std::function<void(int status, const QByteArray& body)>;

    void postJson(const QString& path, const QByteArray& body, bool auth,
                  ReplyCallback cb);
    // Resgate de fato (corpo do redeem), já com o endereço resolvido — roda
    // depois que a rede privada estiver (ou não) de pé.
    void doRedeem(const QString& url, const QString& code);
    // Entrega o host preparado ao Moonlight (heartbeat + playFinished).
    void finishPlay(const QString& host, int port);
    void startHeartbeat();
    void stopHeartbeat();

    QNetworkAccessManager m_nam;
    QString m_baseUrl;
    QString m_token;
    QString m_grantedMode = QStringLiteral("game");
    // Credencial da rede privada vinda do "prepare" (o HOST pode rotacionar
    // a chave) — usada quando o streamTarget é 100.x e a VPN ainda não subiu.
    QString m_onlineKey;
    QString m_onlineCtrl;
    qint64 m_sessionId = 0;
    QTimer* m_heartbeat;
};

#endif // MOONSHINEBACKEND_H
