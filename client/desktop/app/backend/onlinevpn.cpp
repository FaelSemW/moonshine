#include "onlinevpn.h"

#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QTimer>
#include <QUrl>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

namespace {

// Espera sem travar a UI: loop de eventos curto (a janela segue viva).
void waitMs(int ms)
{
    QEventLoop loop;
    QTimer::singleShot(ms, &loop, &QEventLoop::quit);
    loop.exec();
}

} // namespace

OnlineVpn* OnlineVpn::instance()
{
    // Singleton simples: criado na main thread no primeiro uso e vive
    // enquanto o app viver.
    static OnlineVpn* inst = new OnlineVpn();
    return inst;
}

OnlineVpn::OnlineVpn(QObject* parent)
    : QObject(parent)
{
}

bool OnlineVpn::isSupported() const
{
#ifdef Q_OS_WIN
    return true; // no Windows dá para baixar e instalar o oficial
#else
    // Sem download/elevação interativa: só funciona com o binário do SO.
    return !findCli().isEmpty();
#endif
}

// Acha o binário do Tailscale: (a) TS_PATH (atalho de teste), (b) pasta
// padrão do MSI oficial, (c) PATH do sistema.
QString OnlineVpn::findCli() const
{
    const QString env = qEnvironmentVariable("TS_PATH");
    if (!env.isEmpty() && QFileInfo::exists(env)) {
        return env;
    }

#ifdef Q_OS_WIN
    const char* candidates[] = {
        "C:/Program Files/Tailscale/tailscale.exe",
        "C:/Program Files (x86)/Tailscale/tailscale.exe",
    };
    for (const char* c : candidates) {
        const QString path = QDir::toNativeSeparators(QString::fromLatin1(c));
        if (QFileInfo::exists(path)) {
            return path;
        }
    }

    const ProcResult where = run(QStringLiteral("where.exe"), {QStringLiteral("tailscale")}, 10000);
    if (where.started && where.exitCode == 0) {
        const QStringList lines = where.out.split(QLatin1Char('\n'));
        for (const QString& line : lines) {
            const QString path = line.trimmed();
            if (!path.isEmpty() && QFileInfo::exists(path)) {
                return path;
            }
        }
    }
    return QString();
#else
    const QStringList dirs = qEnvironmentVariable("PATH").split(QDir::listSeparator());
    for (const QString& dir : dirs) {
        const QString d = dir.trimmed();
        if (d.isEmpty()) {
            continue;
        }
        const QString cand = QDir(d).filePath(QStringLiteral("tailscale"));
        const QFileInfo fi(cand);
        if (fi.exists() && fi.isFile() && fi.isExecutable()) {
            return cand;
        }
    }
    return QString();
#endif
}

// Roda um comando e espera com loop de eventos aninhado: a UI continua
// respondendo enquanto o processo roda (nada de bloquear a thread principal
// com waitForFinished).
OnlineVpn::ProcResult OnlineVpn::run(const QString& exe, const QStringList& args,
                                     int timeoutMs) const
{
    ProcResult r;

    QProcess p;
    p.setProcessChannelMode(QProcess::SeparateChannels);

    QByteArray outBuf;
    QByteArray errBuf;
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    bool finishedFlag = false;
    int exitCode = -1;

    // Drena os canais enquanto o processo roda (evita deadlock de pipe cheio).
    connect(&p, &QProcess::readyReadStandardOutput, &p,
            [&]() { outBuf += p.readAllStandardOutput(); });
    connect(&p, &QProcess::readyReadStandardError, &p,
            [&]() { errBuf += p.readAllStandardError(); });
    connect(&p, &QProcess::finished, &loop,
            [&](int code, QProcess::ExitStatus) {
                finishedFlag = true;
                exitCode = code;
                loop.quit();
            });
    connect(&timer, &QTimer::timeout, &loop, [&]() { loop.quit(); });

    p.start(exe, args);
    if (!p.waitForStarted(10000)) {
        r.err = p.errorString();
        return r; // nem chegou a rodar
    }
    r.started = true;

    timer.start(timeoutMs);
    if (!finishedFlag) {
        loop.exec(); // sai no finished ou no timeout
    }

    outBuf += p.readAllStandardOutput();
    errBuf += p.readAllStandardError();
    r.out = QString::fromUtf8(outBuf);
    r.err = QString::fromUtf8(errBuf);
    if (finishedFlag) {
        r.exitCode = exitCode;
    } else {
        r.timedOut = true;
        p.kill();
        p.waitForFinished(3000);
    }
    return r;
}

// Estado do backend lido de `tailscale status --json`.
OnlineVpn::TsState OnlineVpn::queryState(const QString& cli) const
{
    TsState st;
    const ProcResult r = run(cli, {QStringLiteral("status"), QStringLiteral("--json")}, 15000);
    if (!r.started || r.timedOut || r.exitCode != 0) {
        return st; // backend fora do ar (ou CLI não instalado)
    }
    const QJsonObject o = QJsonDocument::fromJson(r.out.toUtf8()).object();
    st.reachable = true;
    st.running = o["BackendState"].toString() == QStringLiteral("Running");
    // "Self" pode ser null quando ainda não logou.
    st.online = o["Self"].toObject()["Online"].toBool(false);
    return st;
}

// Baixa o MSI oficial assinado para a pasta temporária (sobrescreve o que
// tiver lá). Caminho devolvido em msiPath.
bool OnlineVpn::downloadMsi(QString* msiPath, QString* err)
{
    // Versão fixada do canal estável oficial do Tailscale.
    const QUrl url(
        QStringLiteral("https://pkgs.tailscale.com/stable/tailscale-setup-1.104.1-amd64.msi"));
    const QString path =
        QDir::toNativeSeparators(QDir::tempPath() + QStringLiteral("/moonshine-tailscale.msi"));

    QFile out(path);
    if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        *err = tr("Não consegui criar o instalador em %1 (%2)").arg(path, out.errorString());
        return false;
    }

    QNetworkRequest req(url);
    req.setTransferTimeout(120000); // 2 min sem dado já é link morto
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    QNetworkReply* reply = m_nam.get(req);

    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    bool doneDl = false;
    connect(reply, &QNetworkReply::readyRead, &loop, [&]() { out.write(reply->readAll()); });
    connect(reply, &QNetworkReply::finished, &loop, [&]() {
        doneDl = true;
        loop.quit();
    });
    connect(&timer, &QTimer::timeout, &loop, [&]() { loop.quit(); });
    timer.start(600000); // folga de 10 min para link lento (~80 MB)
    if (!doneDl) {
        loop.exec();
    }

    out.write(reply->readAll());
    const bool netOk = doneDl && reply->error() == QNetworkReply::NoError;
    const QString netErr = reply->errorString();
    if (!doneDl) {
        reply->abort(); // corta o download travado
    }
    reply->deleteLater();
    out.close();

    if (!netOk) {
        QFile::remove(path);
        *err = doneDl ? tr("Falha ao baixar o Tailscale: %1").arg(netErr)
                      : tr("Download do Tailscale interrompido (tempo esgotado).");
        return false;
    }
    if (QFileInfo(path).size() <= 0) {
        QFile::remove(path);
        *err = tr("Download do Tailscale veio vazio. Baixe manualmente em "
                  "https://tailscale.com/download/windows");
        return false;
    }

    *msiPath = path;
    return true;
}

// Autenticode: só segue com Status "Valid" (2) e assinante contendo
// "Tailscale" — o download é por HTTPS, mas assinatura é a prova real.
bool OnlineVpn::verifySignature(const QString& msiPath, QString* err)
{
    const QString aviso =
        tr("Instalador do Tailscale não passou na verificação de assinatura — baixe "
           "manualmente em https://tailscale.com/download/windows");

    const QString script =
        QStringLiteral("Get-AuthenticodeSignature -FilePath '%1' | "
                       "Select-Object Status,StatusMessage,"
                       "@{n='Signer';e={$_.SignerCertificate.Subject}} | "
                       "ConvertTo-Json -Compress")
            .arg(msiPath);
    const ProcResult r = run(QStringLiteral("powershell.exe"),
                             {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"),
                              QStringLiteral("-Command"), script},
                             30000);
    if (!r.started || r.timedOut || r.exitCode != 0) {
        *err = aviso;
        return false;
    }

    const QJsonObject o = QJsonDocument::fromJson(r.out.toUtf8()).object();
    const QJsonValue status = o["Status"];
    // O PowerShell pode devolver o enum como número (2) ou como texto.
    const bool valid = (status.isDouble() && status.toInt(-1) == 2) ||
                       (status.isString() &&
                        status.toString().compare(QLatin1String("Valid"), Qt::CaseInsensitive) == 0);
    const QString signer = o["Signer"].toString();
    if (!valid || !signer.contains(QLatin1String("Tailscale"), Qt::CaseInsensitive)) {
        *err = aviso;
        return false;
    }
    return true;
}

// Eleva uma vez (UAC), instala em silencioso e espera o binário aparecer.
bool OnlineVpn::installMsi(const QString& msiPath, QString* err)
{
#ifdef Q_OS_WIN
    const QString args = QStringLiteral("/i \"%1\" /qn /norestart").arg(msiPath);
    const HINSTANCE h = ShellExecuteW(nullptr, L"runas", L"msiexec.exe",
                                      reinterpret_cast<LPCWSTR>(args.utf16()), nullptr,
                                      SW_SHOWNORMAL);
    // ShellExecuteW devolve >32 quando aceito; UAC recusado vem como <=32.
    if (reinterpret_cast<INT_PTR>(h) <= 32) {
        *err = tr("Instalação cancelada. O modo online precisa instalar o Tailscale "
                  "(uma única elevação).");
        return false;
    }

    // Espera o executável aparecer (instalação silenciosa, até 120 s).
    const QString cli =
        QDir::toNativeSeparators(QStringLiteral("C:/Program Files/Tailscale/tailscale.exe"));
    QElapsedTimer t;
    t.start();
    while (t.elapsed() < 120000) {
        if (QFileInfo::exists(cli)) {
            return true;
        }
        waitMs(1000);
    }
    if (QFileInfo::exists(cli)) {
        return true;
    }
    *err = tr("A instalação do Tailscale não terminou em 2 minutos. Instale manualmente em "
              "https://tailscale.com/download/windows");
    return false;
#else
    Q_UNUSED(msiPath);
    *err = tr("Instalação automática do Tailscale disponível apenas no Windows.");
    return false;
#endif
}

void OnlineVpn::ensureOnline(const QString& authKey, const QString& controlUrl,
                             std::function<void(bool ok, const QString& err)> cb)
{
    // Tudo roda na thread principal (loops de eventos aninhados): cb é
    // chamado na main e a UI nunca fica presa.
    if (m_ready) {
        if (cb) {
            cb(true, QString());
        }
        return;
    }
    if (m_busy) {
        if (cb) {
            cb(false, tr("Já estamos conectando à rede privada — aguarde um instante."));
        }
        return;
    }
    if (!isSupported()) {
        if (cb) {
            cb(false, tr("Este computador não tem o Tailscale disponível. Instale o Tailscale "
                         "do sistema e tente de novo."));
        }
        return;
    }
    const QString key = authKey.trimmed();
    if (key.isEmpty()) {
        if (cb) {
            cb(false, tr("O código online não trouxe a chave da rede privada."));
        }
        return;
    }
    const QString ctrl = controlUrl.trimmed();

    m_busy = true;
    auto done = [this, cb](bool ok, const QString& err) {
        m_busy = false;
        if (cb) {
            cb(ok, err);
        }
    };

    // 1) Procura o cliente; sem ele, baixa e instala o oficial (só Windows).
    emit statusChanged(tr("Procurando o Tailscale..."));
    QString cli = findCli();
    bool justInstalled = false;
    if (cli.isEmpty()) {
#ifdef Q_OS_WIN
        QString msi;
        QString err;
        emit statusChanged(tr("Baixando o Tailscale oficial (~80 MB)..."));
        if (!downloadMsi(&msi, &err)) {
            done(false, err);
            return;
        }
        emit statusChanged(tr("Instalando o Tailscale (elevação necessária)..."));
        if (!verifySignature(msi, &err)) {
            done(false, err);
            return;
        }
        if (!installMsi(msi, &err)) {
            done(false, err);
            return;
        }
        justInstalled = true;
        cli = findCli();
        if (cli.isEmpty()) {
            done(false, tr("Tailscale instalado, mas o executável não foi encontrado."));
            return;
        }
#else
        done(false, tr("O Tailscale não está instalado neste computador."));
        return;
#endif
    }
    m_cli = cli;

    // 2) Estado ANTES do nosso login: se o PC já está em outra rede, a
    //    conexão não é nossa — nunca vamos deslogar o que é do usuário.
    const TsState before = queryState(cli);
    const bool wasRunning = before.reachable && before.running;

    // Logo após instalar, o serviço do Tailscale ainda está subindo.
    if (justInstalled) {
        QElapsedTimer wt;
        wt.start();
        while (wt.elapsed() < 30000 && !queryState(cli).reachable) {
            waitMs(1000);
        }
    }

    // 3) Entra na rede com a chave que veio no código online.
    emit statusChanged(tr("Entrando na rede privada..."));
    QStringList upArgs;
    upArgs << QStringLiteral("up") << QStringLiteral("--authkey=") + key
           << QStringLiteral("--hostname=moonshine-player")
           << QStringLiteral("--accept-dns=false") << QStringLiteral("--accept-routes=false");
    if (!ctrl.isEmpty()) {
        upArgs << QStringLiteral("--login-server=") + ctrl;
    }
    const ProcResult up = run(cli, upArgs, 60000);
    if (!up.started) {
        done(false, tr("Não consegui executar o Tailscale (%1)").arg(up.err));
        return;
    }
    if (up.timedOut) {
        done(false, tr("O Tailscale demorou demais para entrar na rede privada."));
        return;
    }
    if (up.exitCode != 0) {
        const QString detail = up.err.trimmed();
        if (wasRunning) {
            // Já estava em outra rede e o `up` recusou: avisa sem mexer nela.
            done(false, tr("Este PC já está em outra rede Tailscale. Saia dela ou use outro "
                           "computador.")
                            + (detail.isEmpty() ? QString() : QStringLiteral("\n") + detail));
            return;
        }
#ifndef Q_OS_WIN
        // Sem elevação interativa fora do Windows: deixa a dica honesta.
        const bool semPermissao =
            detail.contains(QLatin1String("permission"), Qt::CaseInsensitive) ||
            detail.contains(QLatin1String("superuser"), Qt::CaseInsensitive) ||
            detail.contains(QLatin1String("root"), Qt::CaseInsensitive) ||
            detail.contains(QLatin1String("sudo"), Qt::CaseInsensitive);
        if (semPermissao) {
            done(false, tr("No Linux/macOS, instale e ative o Tailscale do sistema "
                           "(ex.: sudo tailscale up) e tente de novo."));
            return;
        }
#endif
        done(false, detail.isEmpty() ? tr("falha ao entrar na rede privada (código %1)")
                                            .arg(up.exitCode)
                                      : detail);
        return;
    }
    // Só quem fez o login é dono da sessão (podia já estar logado antes).
    m_oursLoggedIn = !wasRunning;

    // 4) Espera o backend confirmar Running + Self.Online (1s por volta, 60s).
    for (int waited = 0; waited <= 60000; waited += 1000) {
        const TsState st = queryState(cli);
        if (st.reachable && st.running && st.online) {
            m_ready = true;
            emit statusChanged(tr("Rede privada ativa."));
            done(true, QString());
            return;
        }
        if (waited == 60000) {
            break;
        }
        waitMs(1000);
    }
    done(false, tr("tempo esgotado esperando a rede privada"));
}

void OnlineVpn::disconnect()
{
    if (!m_oursLoggedIn) {
        // Sessão alheia (ou nada feito): o PC fica exatamente como está.
        return;
    }
    m_oursLoggedIn = false;
    m_ready = false;

    const QString cli = m_cli.isEmpty() ? findCli() : m_cli;
    if (cli.isEmpty()) {
        return;
    }
    // Melhor esforço: sai da rede que NÓS entramos. O Tailscale instalado
    // permanece no PC, apenas sem sessão ativa.
    run(cli, QStringList{QStringLiteral("logout")}, 15000);
}
