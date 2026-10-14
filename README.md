# Moonshine Cloud Gaming

[![CI](https://github.com/FaelSemW/moonshine/actions/workflows/ci.yml/badge.svg)](https://github.com/FaelSemW/moonshine/actions/workflows/ci.yml) [![Cliente Android](https://github.com/FaelSemW/moonshine/actions/workflows/android.yml/badge.svg)](https://github.com/FaelSemW/moonshine/actions/workflows/android.yml) [![Cliente Desktop](https://github.com/FaelSemW/moonshine/actions/workflows/desktop.yml/badge.svg)](https://github.com/FaelSemW/moonshine/actions/workflows/desktop.yml)

Plataforma própria de cloud gaming: um PC gamer no Bazzite fica disponível para
um jogador por vez, que joga remotamente e tem seu ambiente temporário removido
com segurança ao final da sessão.

Construída sobre os projetos open source comprovados **Sunshine** (servidor de
streaming) e **Moonlight** (clientes), ambos GPL-3.0. Nenhum deles é reescrito.

- **HOST:** serviço Node.js (sem dependências externas) + SQLite. Autenticação,
  reserva exclusiva, isolamento de sessão, gestão do Sunshine e painel
  administrativo integrado. Escuta em loopback; exposto na rede privada via
  Tailscale Serve.
- **CLIENTE Android:** app de **um único APK** que embute o controle do Moonshine
  e o **streaming real do Moonlight** (moonlight-android + moonlight-common-c
  dentro do próprio app). Compilado no CI (artefato `moonshine-client-android`).
  Há também uma **interface web/PWA** usável em qualquer navegador.
- **CLIENTE Windows/Linux:** app de desktop que **embute o Moonlight** (fork do
  moonlight-qt) com a mesma tela de controle Moonshine à frente. Compilado no CI
  (artefato `moonshine-client-windows-x64`, pasta portátil).

> **Honestidade técnica:** o Moonshine é o **plano de controle** (autoriza,
> reserva, prepara, monitora e limpa). Nos **apps Android e Windows** o
> vídeo/áudio/controles são do Moonlight **embutido** no próprio aplicativo; na
> **web/PWA** (navegador) o streaming continua pelo Moonlight externo. Ver
> [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md) e [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Executar o HOST (desenvolvimento)

Requer Node.js 22.5+ (testado com 22.23.3). Sem dependências npm externas.

```sh
npm start        # sobe em http://127.0.0.1:48100
npm test         # 41 testes automatizados
npm run check    # verificação de sintaxe
```

Abra `http://127.0.0.1:48100`, crie o administrador na primeira tela e use o
painel. Em Windows/macOS o HOST opera em modo de desenvolvimento (isolamento de
SO desativado); ele **não** finge streaming.

## Acesso dos jogadores (convite + dois modos)

O administrador gera um **código de convite** na aba **Convites** e envia ao
jogador. O código **é** a credencial — não há senha de plataforma. Cada código
carrega o modo da sessão:

- **game** (recomendado): sessão isolada — usuário Linux dedicado, HOME
  temporário descartável, biblioteca somente leitura, remoção verificada ao
  final (bloqueio se falhar).
- **full**: PC completo — o jogador passa a controlar o **desktop do dono**
  (o dono escolheu abrir a máquina; sem isolamento). Nos apps, o Moonlight
  entra no app **Desktop** do Sunshine.

Limitação declarada (fase 2): os apps/jogos do Sunshine ainda são lançados na
conta do dono — a identidade isolada, o HOME descartável e a limpeza verificada
são reais; o isolamento de input completo vem com o runtime da fase 2
(ver [docs/SECURITY.md](docs/SECURITY.md), "Limites honestos").

O painel lista os códigos emitidos (modo, usos, validade, status) e permite
**copiar** ou **revogar**. Nos **apps Android/Windows** o pareamento com o
Sunshine é **automático**: o PIN é gerado pelo próprio app e entregue ao HOST,
que o repassa à API oficial do Sunshine — ninguém digita PIN. Os apps aceitam
também login por usuário/senha (sempre modo `game`).

No PC do dono, o **modo online** é via **Tailscale** (nada na internet pública):
assistente do painel → passo 3 aponta painel e Sunshine ao IP Tailscale.

### CLI de diagnóstico e configuração

```sh
npm run doctor          # verifica SO, GPU, Sunshine, pareamento e estado
npm run setup-sunshine  # configura credenciais do Sunshine + app "Desktop"
node host/src/cli.js create-user jogador1 senha123   # cria um jogador
node host/src/cli.js state                          # estado da máquina
node host/src/cli.js unlock                         # libera máquina travada
```

## Implantação no Bazzite

Siga [docs/BAZZITE.md](docs/BAZZITE.md). **Um comando** no Desktop Mode do Bazzite:

```bash
curl -fsSL https://raw.githubusercontent.com/FaelSemW/moonshine/main/deploy/bazzite/install.sh | bash
```

Instala Node.js local (sem root), garante o Sunshine via Flatpak oficial, clona
o código para `~/moonshine` e registra uma user unit do systemd. Nada altera a
raiz imutável. Há **um único sudo, opcional**, no meio da instalação: autoriza
o `moonshine-helper.sh` via sudoers (é o que cria/remove o usuário dedicado do
modo `game`; recusar deixa só o modo `full` disponível).

## Arquitetura

```
Cliente (Android/Windows/PWA) ──HTTP/Tailscale──► HOST Moonshine (Node+SQLite)
   │  autentica, reserva, estado             │ valida, reserva, prepara,
   │                                         │ monitora, limpa
   └──► Moonlight (embutido no app) ──GameStream──► Sunshine ──► GPU/jogo
```

- O **vídeo/áudio/entra­da** vai direto Moonlight ↔ Sunshine (baixa latência).
- O **controle** (quem pode jogar, quando, e limpeza) é do Moonshine.

## Isolamento de sessão

Cada sessão usa um **usuário Linux dedicado** com `HOME` temporário descartável;
a biblioteca de jogos é **somente leitura**; se a limpeza falhar, a máquina fica
**bloqueada** até recuperação administrativa. Detalhes e limites em
[docs/SECURITY.md](docs/SECURITY.md).

## Documentação

- [docs/TESTING.md](docs/TESTING.md) — **guia de teste de ponta a ponta (comece aqui)**
- [docs/ANDROID.md](docs/ANDROID.md) — cliente Android: compilar e instalar o APK
- [docs/DESKTOP.md](docs/DESKTOP.md) — cliente Windows/Linux: compilar o app desktop
- [docs/BAZZITE.md](docs/BAZZITE.md) — instalação, configuração e recuperação
- [docs/SECURITY.md](docs/SECURITY.md) — modelo de segurança e isolamento
- [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md) — licenças e obrigações
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — roteiro de homologação em hardware
- [docs/REPORT.md](docs/REPORT.md) — o que foi implementado e validado

## Licença

GPL-3.0-only. Ver [LICENSE](LICENSE).
