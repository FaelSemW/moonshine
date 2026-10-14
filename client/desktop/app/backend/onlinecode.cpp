#include "onlinecode.h"

#include <QStringList> // Qt6: QStringList não vem embutido em QString

namespace {

// Alfabeto base32 de Crockford (sem I/L/O/U visuais — a leitura tolera
// I/L → 1 e O → 0; o U é proibido e invalida o código).
const QString& alphabet()
{
    static const QString a = QStringLiteral("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    return a;
}

// Valor de um símbolo Crockford; -1 quando inválido.
int symbolValue(QChar c)
{
    if (c == QLatin1Char('I') || c == QLatin1Char('L')) {
        return 1;
    }
    if (c == QLatin1Char('O')) {
        return 0;
    }
    return alphabet().indexOf(c);
}

// Decodifica símbolos base32 (5 bits) em bytes (8 bits), MSB primeiro.
// Os bits finais que não completam um byte são descartados (como nas
// referências JS/Java). Devolve false se houver símbolo inválido.
bool b32decode(const QString& in, QByteArray* out)
{
    out->clear();
    quint32 acc = 0;
    int bits = 0;
    for (QChar ch : in) {
        const int v = symbolValue(ch);
        if (v < 0) {
            return false;
        }
        acc = (acc << 5) | quint32(v);
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out->append(char((acc >> bits) & 0xff));
        }
    }
    return true;
}

} // namespace

OnlineCode OnlineCode::parse(const QString& raw)
{
    OnlineCode oc;

    const QString s = raw.trimmed().toUpper();
    if (!s.startsWith(QStringLiteral("MS1-"))) {
        return oc;
    }

    // Mantém só dígitos e letras maiúsculas (cai fora '-', espaços e
    // qualquer sujeira visual — igual às referências).
    QString clean;
    clean.reserve(s.size());
    for (int i = 4; i < s.size(); i++) {
        const QChar c = s.at(i);
        if ((c >= QLatin1Char('0') && c <= QLatin1Char('9')) ||
            (c >= QLatin1Char('A') && c <= QLatin1Char('Z'))) {
            clean.append(c);
        }
    }

    QByteArray b;
    if (!b32decode(clean, &b)) {
        return oc;
    }
    // Payload mínimo: versão + token + IPv4 + comprimentos = 18 bytes.
    if (b.size() < 18) {
        return oc;
    }

    int p = 0;
    if (quint8(b.at(p++)) != 1) {
        return oc; // versão desconhecida
    }
    const int tokenLen = quint8(b.at(p++));
    if (tokenLen != 10 || b.size() < p + tokenLen + 4 + 1) {
        return oc;
    }

    // Cada byte do token deve ser um símbolo base32 válido (0..31).
    QString token;
    for (int i = 0; i < tokenLen; i++) {
        const int v = quint8(b.at(p + i));
        if (v > 31) {
            return oc;
        }
        token.append(alphabet().at(v));
    }
    p += tokenLen;

    oc.hostIpv4 = QStringLiteral("%1.%2.%3.%4")
                      .arg(int(quint8(b.at(p))))
                      .arg(int(quint8(b.at(p + 1))))
                      .arg(int(quint8(b.at(p + 2))))
                      .arg(int(quint8(b.at(p + 3))));
    p += 4;

    const int keyLen = quint8(b.at(p++));
    if (b.size() < p + keyLen + 1) {
        return oc;
    }
    oc.authKey = QString::fromUtf8(b.constData() + p, keyLen);
    p += keyLen;

    const int ctrlLen = quint8(b.at(p++));
    if (b.size() < p + ctrlLen) {
        return oc;
    }
    oc.controlUrl = QString::fromUtf8(b.constData() + p, ctrlLen);

    // O token volta ao formato clássico XXXXX-XXXXX (usado pelo resgate).
    oc.token = token.left(5);
    oc.token += QLatin1Char('-');
    oc.token += token.mid(5);
    oc.valid = true;
    return oc;
}

bool isPrivateNetHost(const QString& host)
{
    const QStringList parts = host.split(QLatin1Char('.'));
    if (parts.size() != 4) {
        return false;
    }
    // Precisa ser IPv4 de verdade (4 octetos 0..255) antes de tudo.
    for (const QString& part : parts) {
        bool ok = false;
        const int v = part.toInt(&ok);
        if (!ok || v < 0 || v > 255) {
            return false;
        }
    }
    // CGNAT 100.64.0.0/10 — o intervalo que o Tailscale usa (100.x).
    return parts.at(0).toInt() == 100 && parts.at(1).toInt() >= 64 &&
           parts.at(1).toInt() <= 127;
}
