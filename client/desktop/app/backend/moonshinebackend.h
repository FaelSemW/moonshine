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
    Q_INVOKABLE void play();
    Q_INVOKABLE void endSession();
    Q_INVOKABLE void logout();

signals:
    void loginFinished(bool ok, const QString& error);
    void playFinished(bool ok, const QString& streamHost, int streamPort,
                      const QString& error);
    void statusChanged(const QString& text);
    void sessionEnded();

private:
    using ReplyCallback = std::function<void(int status, const QByteArray& body)>;

    void postJson(const QString& path, const QByteArray& body, bool auth,
                  ReplyCallback cb);
    void startHeartbeat();
    void stopHeartbeat();

    QNetworkAccessManager m_nam;
    QString m_baseUrl;
    QString m_token;
    qint64 m_sessionId = 0;
    QTimer* m_heartbeat;
};

#endif // MOONSHINEBACKEND_H
