#ifndef ONLINECODE_H
#define ONLINECODE_H

#include <QString>

// Código de convite "online" (MS1-...) — espelho desktop de
// host/src/onlinecode.js e do client/android .../OnlineCode.java. Carrega,
// em um único campo colável: token do convite + IPv4 do HOST na rede
// privada + chave da autenticação da rede + URL de controle opcional.
//
// Isso resolve o pega-eto do modo online: o APP precisa estar na rede
// privada (Tailscale, 100.x) para alcançar o HOST, mas a chave vinha do
// próprio HOST. Com o código online, o app entra na rede PRIMEIRO e só
// depois fala com o HOST — o amigo instala apenas o app Moonshine.
//
// Layout v1 (bytes antes do base32 de Crockford, prefixo "MS1-"):
//   byte 0        : versão (1)
//   byte 1        : comprimento do token (10)
//   10 bytes      : valores dos símbolos do token (0..31 cada)
//   4 bytes       : IPv4 do HOST na rede privada
//   byte + N      : comprimento e bytes UTF-8 da chave de autenticação
//   byte + M      : comprimento e bytes UTF-8 da URL de controle (0 = padrão)
struct OnlineCode {
    bool valid = false;
    // Token no formato clássico XXXXX-XXXXX (usado pelo resgate).
    QString token;
    // IPv4 do HOST na rede privada (ex.: 100.64.0.9).
    QString hostIpv4;
    // Chave de autenticação da rede (vazio se o código não trouxe chave).
    QString authKey;
    // URL de controle alternativa (vazio = padrão do Tailscale).
    QString controlUrl;

    // Decodifica um código online; devolve valid=false se não for válido.
    static OnlineCode parse(const QString& raw);
};

// true se o host está em 100.64.0.0/10 (CGNAT usado pela rede Tailscale).
bool isPrivateNetHost(const QString& host);

#endif // ONLINECODE_H
