#include "moonshinebackend.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QUrl>

MoonshineBackend::MoonshineBackend(QObject* parent)
    : QObject(parent),
      m_heartbeat(new QTimer(this))
{
    // Mantém a sessão viva enquanto o jogador estiver conectado.
    m_heartbeat->setInterval(5000);
    connect(m_heartbeat, &QTimer::timeout, this, [this]() {
        if (m_sessionId <= 0) {
            return;
        }
        QJsonObject o;
        o["sessionId"] = static_cast<double>(m_sessionId);
        postJson("/api/session/heartbeat", QJsonDocument(o).toJson(QJsonDocument::Compact), true,
                 [this](int status, const QByteArray&) {
                     // Sessão revogada/expirada no host: avisa a UI.
                     if (status == 401 || status == 404) {
                         stopHeartbeat();
                         m_sessionId = 0;
                         emit sessionEnded();
                     }
                 });
    });
}

void MoonshineBackend::login(const QString& baseUrl,
                             const QString& username,
                             const QString& password)
{
    m_baseUrl = baseUrl.trimmed();
    while (m_baseUrl.endsWith('/')) {
        m_baseUrl.chop(1);
    }

    QJsonObject o;
    o["username"] = username;
    o["password"] = password;

    emit statusChanged(tr("Entrando..."));
    postJson("/api/login", QJsonDocument(o).toJson(QJsonDocument::Compact), false,
             [this](int status, const QByteArray& body) {
                 if (status == 200) {
                     QJsonObject r = QJsonDocument::fromJson(body).object();
                     m_token = r["token"].toString();
                     emit loginFinished(true, "");
                 } else {
                     QJsonObject e = QJsonDocument::fromJson(body).object();
                     QString err = e["error"].toString();
                     emit loginFinished(false, err.isEmpty() ? QString::number(status) : err);
                 }
             });
}

void MoonshineBackend::play()
{
    emit statusChanged(tr("Reservando sessão..."));
    postJson("/api/session/reserve", QByteArrayLiteral("{}"), true,
             [this](int status, const QByteArray& body) {
                 if (status != 200) {
                     QJsonObject e = QJsonDocument::fromJson(body).object();
                     QString err = e["error"].toString();
                     if (status == 409) {
                         err = tr("PC ocupado por outro jogador.");
                     } else if (err.isEmpty()) {
                         err = QString::number(status);
                     }
                     emit playFinished(false, "", 0, err);
                     return;
                 }

                 m_sessionId = QJsonDocument::fromJson(body).object()["sessionId"].toVariant().toLongLong();

                 emit statusChanged(tr("Preparando ambiente..."));
                 QJsonObject o;
                 o["sessionId"] = static_cast<double>(m_sessionId);
                 postJson("/api/session/prepare", QJsonDocument(o).toJson(QJsonDocument::Compact), true,
                          [this](int st, const QByteArray& b2) {
                              if (st != 200) {
                                  QJsonObject e = QJsonDocument::fromJson(b2).object();
                                  QString err = e["error"].toString();
                                  emit playFinished(false, "", 0, err.isEmpty() ? QString::number(st) : err);
                                  return;
                              }

                              QString target = QJsonDocument::fromJson(b2).object()["streamTarget"].toString();

                              // Separa host:porta (suporta IPv6 entre colchetes).
                              QString host = target;
                              int port = 47989;
                              if (target.startsWith('[')) {
                                  int close = target.indexOf(']');
                                  if (close > 0) {
                                      host = target.mid(1, close - 1);
                                      if (close + 1 < target.size() && target.at(close + 1) == ':') {
                                          port = target.mid(close + 2).toInt();
                                      }
                                  }
                              } else {
                                  int ci = target.lastIndexOf(':');
                                  if (ci > 0) {
                                      host = target.left(ci);
                                      port = target.mid(ci + 1).toInt();
                                  }
                              }

                              startHeartbeat();
                              emit playFinished(true, host, port, "");
                          });
             });
}

void MoonshineBackend::endSession()
{
    stopHeartbeat();
    qint64 sid = m_sessionId;
    m_sessionId = 0;
    if (sid <= 0) {
        emit sessionEnded();
        return;
    }
    QJsonObject o;
    o["sessionId"] = static_cast<double>(sid);
    postJson("/api/session/end", QJsonDocument(o).toJson(QJsonDocument::Compact), true,
             [this](int, const QByteArray&) { emit sessionEnded(); });
}

void MoonshineBackend::logout()
{
    stopHeartbeat();
    if (m_sessionId > 0) {
        endSession();
    }
    m_token.clear();
}

void MoonshineBackend::postJson(const QString& path, const QByteArray& body, bool auth,
                                ReplyCallback cb)
{
    QNetworkRequest req(QUrl(m_baseUrl + path));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    req.setTransferTimeout(20000);
    if (auth && !m_token.isEmpty()) {
        req.setRawHeader("Authorization", "Bearer " + m_token.toUtf8());
    }

    QNetworkReply* reply = m_nam.post(req, body);
    connect(reply, &QNetworkReply::finished, this, [reply, cb]() {
        int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        QByteArray data = reply->readAll();
        reply->deleteLater();
        cb(status, data);
    });
}

void MoonshineBackend::startHeartbeat()
{
    m_heartbeat->start();
}

void MoonshineBackend::stopHeartbeat()
{
    m_heartbeat->stop();
}
