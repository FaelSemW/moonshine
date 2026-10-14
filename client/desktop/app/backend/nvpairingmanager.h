#pragma once

#include "identitymanager.h"
#include "nvhttp.h"

#include <openssl/x509.h>
#include <openssl/evp.h>

class NvPairingManager
{
public:
    enum PairState
    {
        PAIRED,
        PIN_WRONG,
        FAILED,
        ALREADY_IN_PROGRESS
    };

    explicit NvPairingManager(NvComputer* computer);

    ~NvPairingManager();

    PairState
    pair(QString appVersion, QString pin, QSslCertificate& serverCert);

    // ---- Moonshine (fork): relay automático do PIN ---------------------------
    //
    // Com a URL/token do Moonshine definidos, pair() entrega o PIN ao plano de
    // controle ENTRE o getservercert (que cria o pareamento pendente no
    // Sunshine) e o clientchallenge (que exige o PIN já conhecido lá) — mesma
    // ordem do fluxo manual, sem corrida e sem o jogador digitar nada. Sem relay
    // (baseUrl/token vazios), o comportamento é 100% o oficial.
    static void setMoonshineRelay(const QString& baseUrl, const QString& token);

private:
    QByteArray
    generateRandomBytes(int length);

    QByteArray
    saltPin(const QByteArray& salt, QString pin);

    QByteArray
    encrypt(const QByteArray& plaintext, const QByteArray& key);

    QByteArray
    decrypt(const QByteArray& ciphertext, const QByteArray& key);

    QByteArray
    getSignatureFromCert(X509* cert);

    QByteArray
    getSignatureFromPemCert(const QByteArray& certificate);

    bool
    verifySignature(const QByteArray& data, const QByteArray& signature, const QByteArray& serverCertificate);

    QByteArray
    signMessage(const QByteArray& message);

    NvHTTP m_Http;
    X509* m_Cert;
    EVP_PKEY* m_PrivateKey;
};
