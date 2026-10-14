# Componentes de Terceiros e Licenças

Este projeto (Moonshine Cloud Gaming) **não** redistribui código derivado dos
projetos abaixo dentro do seu próprio código-fonte. Ele os utiliza como
**componentes externos** e, quando incorpora lógica de integração, o faz
respeitando as licenças. Todos os quatro projetos base são **GPL-3.0**.

Os repositórios foram clonados para `third_party/` apenas durante o
desenvolvimento como referência de API (fora do Git — ver `.gitignore`). Os SHAs
exatos estão registrados abaixo para rastreabilidade.

## Sunshine (servidor de streaming)

- Repositório: https://github.com/LizardByte/Sunshine
- Licença: **GPL-3.0** (`third_party/sunshine/LICENSE`)
- SHA verificado: `b261a1b95ea2e309e4f1d25dada69f554cf0a51f` (2026-10-12)
- Uso neste projeto: **componente externo**. O HOST do Moonshine fala a API HTTP
  real do Sunshine (GameStream `/serverinfo` na porta 47989 e config API na
  47990) para ler estado e gerenciar a sessão. Não copiamos código do Sunshine
  para o nosso código. Na implantação, o Sunshine roda como **Flatpak oficial**
  (`dev.lizardbyte.app.Sunshine`).
- Obrigações: se você distribuir um binário que **incorpore** Sunshine (por
  exemplo, empacotá-lo junto), o GPL-3 exige disponibilizar o código-fonte
  correspondente do Sunshine. Usá-lo como Flatpak instalado pelo usuário não
  impõe isso ao nosso código.

## Moonlight (clientes de streaming)

- Repositório (PC/Qt): https://github.com/moonlight-stream/moonlight-qt — GPL-3.0
  - SHA verificado: `71c3191e0c5be46fd775549cbc014fe5bb0d068a` (2026-10-12)
- Repositório (Android): https://github.com/moonlight-stream/moonlight-android — GPL-3.0
  - SHA verificado: `b48494cb96bff23d8886c4775cc4f39a1075495d` (2026-09-12)
- Repositório (biblioteca comum C): https://github.com/moonlight-stream/moonlight-common-c — GPL-3.0
  - SHA verificado: `f900dd4767759c7b9d0e93bcea666b55c69ea62f` (2026-09-26)
- Uso neste projeto: o **cliente Android** (`client/android/`) **embuti** o
  moonlight-android (código, recursos e build nativo ndkBuild) dentro do próprio
  APK, junto com `moonlight-common-c` (submódulo fixado no SHA acima) e as
  bibliotecas nativas openssl/opus. O resultado é **um único app**: a tela de
  controle do Moonshine (login → reserva → sessão) e o streaming real do
  Moonlight. Não simulamos vídeo/áudio/controles. O **HOST** continua usando o
  Sunshine como Flatpak externo (não incorpora Sunshine). O cliente
  **Windows/Linux** (`client/desktop/`) também **embuti** o Moonlight, desta vez
  via fork do **moonlight-qt** (Qt/QML + moonlight-common-c), gerando um app
  portátil.
- Obrigações: incorporar moonlight-android/moonlight-common-c (Android) e
  moonlight-qt (desktop) torna os apps derivados **GPL-3**. Cumprimos publicando
  o **código-fonte integral** neste mesmo repositório público: o código
  moonlight-android está versionado em `client/android/app/src/main/`, o
  moonlight-qt em `client/desktop/`, e o `moonlight-common-c` é um submódulo
  fixado no SHA público acima. O `applicationId` do Android foi trocado para
  `com.moonshine.client` (pedido explícito dos mantenedores do Moonlight).

## Tailscale (rede privada / VPN embutida)

- Repositório: https://github.com/tailscale/tailscale — **BSD-3-Clause**
  (cliente; alguns recursos de servidor/coordenação têm termos próprios)
- Uso neste projeto: **modo online embutido** — o HOST guarda a chave de
  autenticação da rede do dono e a entrega (em `prepare` autenticado) aos
  **apps dos jogadores**, que incorporam o cliente Tailscale para entrar
  sozinhos na rede privada (sem app de VPN separado no dispositivo do
  jogador). A coordenação da rede usa o serviço do Tailscale (conta do dono);
  URL de controle alternativa (Headscale auto-hospedado) é suportada no
  config. Incorporação dos clientes: fase em implementação.
- Obrigações: BSD-3-Clause é compatível com GPL-3 (incorporação permitida com
  atribuição — `THIRD_PARTY.md` e créditos dos apps). **Marca**: "Tailscale" e
  logotipo são marcas; nos apps o recurso aparece como "modo online"/"VPN
  privada", sem usar o nome como nome do produto. Plano gratuito do Tailscale
  tem limites de usuários/dispositivos — verifique os atuais no site deles.

## Licença deste projeto

O código-fonte próprio do Moonshine Cloud Gaming é publicado sob **GPL-3.0-only**
(ver `LICENSE`), compatível com os componentes que integra e com a
redistribuição conjunta, quando necessária.

## Resumo das obrigações de distribuição

| Ação | Exige publicar código-fonte? |
|---|---|
| HOST usa Sunshine como Flatpak externo | Não |
| Redistribuir binário Sunshine junto do seu produto | Sim (GPL-3 do Sunshine) |
| Cliente Android embute moonlight-android/common-c | Sim — publicado aqui (GPL-3) |
| Cliente Windows embute moonlight-qt | Sim — publicado aqui (GPL-3) |
| Serviço de controle Moonshine (nosso código) | Sim (publicado como GPL-3) |

> Nota honesta: os clientes Android **e** Windows já incorporam, respectivamente,
> moonlight-android/moonlight-common-c e moonlight-qt; por isso são derivados
> GPL-3 e o código-fonte integral é oferecido neste repositório público. O HOST
> **não** incorpora Sunshine (usa o Flatpak externo).
