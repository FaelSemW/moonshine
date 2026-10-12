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
- Uso neste projeto: **componentes externos**. O cliente Moonshine reserva a
  sessão no HOST e então delega o streaming real ao Moonlight, que conecta
  diretamente no Sunshine. Em Android usa-se o deep-link `moonlight://`; em
  desktop, o Moonlight-Qt pareado. Não simulamos vídeo/áudio/controles.
- Obrigações: incorporar moonlight-common-c em um app (por exemplo,decoder
  embutido) tornaria o app derivado GPL-3, exigindo publicar o código-fonte. A
  primeira versão **não** incorpora; usa o app Moonlight instalado.

## Licença deste projeto

O código-fonte próprio do Moonshine Cloud Gaming é publicado sob **GPL-3.0-only**
(ver `LICENSE`), compatível com os componentes que integra e com a
redistribuição conjunta, quando necessária.

## Resumo das obrigações de distribuição

| Ação | Exige publicar código-fonte? |
|---|---|
| Usar Sunshine/Moonlight instalados pelo usuário (Flatpak/app) | Não |
| Redistribuir binário Sunshine junto do seu produto | Sim (GPL-3 do Sunshine) |
| Incorporar moonlight-common-c no seu app | Sim (GPL-3) |
| Serviço de controle Moonshine (nosso código) | Sim (publicado como GPL-3) |

> Nota honesta: a primeira versão usa os apps Sunshine e Moonlight como
> componentes externos instalados. Se num release futuro o streaming for
> embutido via moonlight-common-c, o release passa a ser GPL-3 completo e o
> código-fonte integral deve ser oferecido ao usuário.
