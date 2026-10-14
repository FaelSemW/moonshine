# Roteiro de Homologação em Hardware Real

Este documento lista o que **precisa ser validado em hardware real** (Bazzite com
GPU, Android, rede Tailscale), pois o ambiente de desenvolvimento (Windows, sem
GPU de jogo, sem Bazzite, sem Android SDK) não permite executar esses itens.

## O que foi validado (evidências)

### Teste real de ponta a ponta (Sunshine ativo, 2026-10-13)

Executado no ambiente de desenvolvimento, apontando o HOST para um **Sunshine
real rodando** (porta GameStream 47989). Resultados confirmados:

- HOST detectou o Sunshine real → máquina `available`.
- Login admin + criação de jogador via API.
- Reserva de sessão → `sessionId 1`.
- **Trava de sessão simultânea:** segunda reserva de outro usuário → **409 Conflict**.
- `prepare` falou com o Sunshine real → sessão `active`, `streamTarget 127.0.0.1:47989`.
- `heartbeat` mantém `active` / máquina `in-use`.
- `end` → limpeza executada → máquina voltou a **`available`**.
- Sessão registrada com `cleanup_ok = 1`; pasta temporária de sessões **descartada**.

Este é o plano de controle completo funcionando contra um Sunshine de verdade.
O streaming de vídeo em si (Moonlight ↔ Sunshine) e o isolamento por usuário
dedicado dependem do hardware Bazzite (itens abaixo).

### Suíte automatizada

- `npm run check` → sintaxe de todos os módulos OK.
- `npm test` → **39/39 aprovados** (no Windows 38 + 1 pulado por ser Linux;
  na CI Linux rodam os 39, incluindo o ciclo real do helper).
- CI GitHub Actions → verde (build + boot do HOST + shellcheck do instalador
  **e do helper privilegiado**).

### Cliente Android — compila para APK (CI, 2026-10-14)

O cliente Android (`client/android/`) é **um único APK** que embute o controle do
Moonshine e o streaming do Moonlight (moonlight-android + submodule
moonlight-common-c). O workflow **Cliente Android** compilou com sucesso no
GitHub Actions:

- JDK 17 + NDK `29.0.14206865`; `moonlight-common-c` fixado no SHA oficial.
- `./gradlew assembleNonRootDebug` → **verde**.
- Artefato `moonshine-client-android` (APK, **16,4 MB**) publicado.

### Cliente Desktop Windows — compila para pacote portátil (CI, 2026-10-14)

O cliente Windows (`client/desktop/`) é um **fork do moonlight-qt** com a tela
de controle do Moonshine à frente. O workflow **Cliente Desktop** compilou com
sucesso no GitHub Actions (mesma receita do upstream):

- `windows-2025` + Qt `6.12.0` + `setup-deps.ps1` (deps pré-compiladas).
- `scripts/build-arch.bat Release x64` → **verde** (compilação nativa +
  `windeployqt`; etapa MSI/WiX removida do fork).
- Artefato `moonshine-client-windows-x64` (pasta portátil, **37,3 MB**)
  publicado.

## O que JÁ foi validado neste ambiente (evidências)

- [x] HOST Node.js inicia e responde (`/api/health`, `/api/setup-required`).
- [x] Ciclo de autenticação: setup → login → token → logout/revogação.
- [x] Proteção contra força bruta (bloqueio 429 após 5 falhas).
- [x] Reserva exclusiva: dois jogadores não podem reservar ao mesmo tempo.
- [x] Reconexão do mesmo usuário não duplica sessão.
- [x] Ciclo completo: preparar → ativa → limpeza → liberação.
- [x] Detecção de fim de sessão por Sunshine livre → limpeza automática.
- [x] Máquina `locked` recusa nova sessão até `unlock`.
- [x] Validação de caminho contra path traversal e symlink escape no descarte.
- [x] Descarte remove o ambiente temporário; verificação pós-limpeza.
- [x] Interface web serve corretamente e bloqueia traversal estático.
- [x] **Códigos de convite** (credencial do jogador): geração Crockford base32
      `XXXXX-XXXXX`, resgate com rate limit por IP, validade/usos/revogação e
      modo carregado pelo token (nunca input livre do cliente).
- [x] **Dois modos de sessão:** `game` (isolamento completo, padrão de todo
      login por senha) e `full` (pula isolamento, registra evento de aviso).
- [x] **Auto-pareamento:** `POST /api/pair/pin` valida PIN, autentica, escolhe
      o pareamento pendente e repassa à API oficial do Sunshine (stub cobre
      400/401/409/200).
- [x] **Porta do HOST = 48100** (47990 é a Web UI do Sunshine; na mesma
      máquina um dos dois falharia ao escutar).
- [x] Painel: aba **Convites** (gerar/copiar/revogar) validado no navegador e
      **login por código** no web client (fluxo real no navegador).
- [x] **Helper de isolamento** (`deploy/bazzite/moonshine-helper.sh`):
      única porta de root do modo `game` (useradd/userdel/chown/pkill via
      sudoers restrito). Toda entrada é validada por regex (exit 64 fora do
      padrão) e o **ciclo real** — criar usuário dedicado → chown → release →
      userdel → `verifyCleanup` limpo — roda como teste na **CI Linux**
      (`tests/test-isolation-helper.js`).
- [x] Descarte **devolve a propriedade** do diretório ao serviço (`release`)
      antes do `rm` — sem isso o Linux daria EACCES e a máquina travaria.
- [x] 41 testes automatizados passando (`npm test`).
- [x] **Modo online embutido (HOST)**: chave da rede privada (Tailscale) salva
      no painel sem ecoar o segredo; entrega **apenas** em
      `/api/session/prepare` sob Bearer de sessão; painel admin vê só
      `configured: true`; desativar limpa o acesso (`npm test`).
- [x] **Detecção do Tailscale aceita o CLI do Flatpak** (Bazzite):
      `flatpak run --command=tailscale com.tailscale.tailscale ...`; o painel
      exibe o comando com o prefixo correto.

Procedimento para reproduzir: `npm test` e `npm start` nesta máquina.

## Pendente — HOST no Bazzite real

- [ ] Instalação via `deploy/bazzite/install.sh` num Bazzite com GPU.
      Procedimento: rodar no Desktop Mode, responder **ao único sudo**
      (helper de isolamento), conferir `sudo -l | grep moonshine-helper`,
      abrir `127.0.0.1:48100`, criar admin.
- [ ] Sunshine Flatpak instalado, com permissão de GPU e codificação ativa.
      Procedimento: painel do Sunshine → verificar VA-API/NVENC; conferir se
      `/serverinfo` (47989) responde.
- [ ] Criação real de usuário Linux dedicado (`useradd`) e descarte (`userdel`)
      **pelo helper/sudoers no Bazzite**. Procedimento: iniciar sessão como
      jogador (modo `game`), conferir `id msplayer-*`,
      `getent passwd msplayer-*` (HOME apontando para
      `/var/tmp/moonshine-sessions/.../home`), `sudo -l` mostrando só o helper,
      e que usuário + diretório somem ao final (`getent passwd | grep msplayer`
      vazio, `/var/tmp/moonshine-sessions` vazio).
- [ ] Isolamento real: jogador não lê arquivos do proprietário.
      ⚠ **Depende da fase 2 de runtime** (jogo/streaming rodando como o usuário
      dedicado — ver `SECURITY.md` "Limites honestos"): hoje os apps do
      Sunshine rodam na conta do dono. Até lá, validar o que já é real: HOME
      temporário `0700` dono `msplayer-*` e que arquivos do dono não são
      legíveis **para processos do usuário dedicado**
      (`sudo -u msplayer-* ls ~dono` → erro de permissão).
- [ ] Biblioteca de jogos somente-leitura de verdade.
      Procedimento: tentar gravar no diretório da biblioteca dentro da sessão.
- [ ] Autostart do serviço via systemd --user após reboot.

## Pendente — Fase 2 (runtime do modo `game`)

- [ ] Streaming/jogo rodando **dentro da sessão do usuário dedicado** (ex.:
      sessão Gamescope por sessão, Sunshine da sessão) para entregar o
      isolamento de input prometido. Enquanto não existir, `SECURITY.md`
      marca a limitação e o modo `game` não a afirma. Depois disso, o item
      "Isolamento real" acima passa a ser testável como escrito.

## Pendente — Streaming real

- [ ] Pareamento real com o Sunshine do HOST.
      Procedimento: com os **apps Moonshine**, adicionar o host e confirmar que
      o pareamento termina **sem digitar PIN** (auto-pair); com Moonlight
      oficial, PIN manual pelo painel (aba Sunshine).
- [ ] Streaming real de vídeo/áudio/controles iniciado após a reserva no Moonshine.
      Procedimento: reservar pelo Moonshine, abrir Moonlight, lançar, jogar.
- [ ] Fim de sessão detectado quando o jogador sai do Moonlight → limpeza.

## Pendente — Cliente

- [x] Android: APK compila no CI (Moonshine + Moonlight embutido,
      `applicationId com.moonshine.client`). Artefato `moonshine-client-android`.
- [ ] Android (hardware): instalar o APK num aparelho real, entrar com **código
      de convite**, reservar, parear (**automático, sem digitar PIN**) e
      confirmar o streaming real. Procedimento: ver `docs/ANDROID.md`.
- [x] Windows: app desktop compila no CI (fork do moonlight-qt + tela Moonshine,
      x64, sem WiX). Artefato `moonshine-client-windows-x64` (37,3 MB).
- [ ] Windows (hardware): instalar num PC Windows real, entrar com código,
      reservar, parear (**automático, sem digitar PIN**) e confirmar o
      streaming real. Procedimento: ver `docs/DESKTOP.md`.
- [ ] Linux: mesmo código do cliente desktop; empacotar (.AppImage/.deb) e
      validar em distro real.
- [x] **VPN embutida nos apps (modo online)** — implementada nos dois apps:
      Android (biblioteca oficial `libtailscale` via gomobile, VpnService sem
      root) e Windows (instala o cliente oficial com verificação de assinatura
      + elevação única e dirige via CLI). O convite virou autossuficiente
      (código `MS1-` com endereço + chave) — fim do pega-eto chave↔VPN.
      Compilação: CI (APK e executável); HOST coberto por teste.
- [ ] **VPN embutida — validação em hardware**: com chave configurada, entrar
      com código `MS1-` em aparelho Android e PC Windows EXTERNOS (só internet)
      e confirmar: consentimento/instalação → "Rede privada ativa" → resgate →
      streaming real ao `streamTarget` `100.x` → saída da rede ao encerrar.
      Procedimento: `docs/TESTING.md` Etapa 14.

## Como cada pendência será confirmada

Cada item acima tem um procedimento objetivo. Onde falhar, registre o log do
serviço (`/api/admin/events`), o estado da máquina e o output de
`journalctl --user -u moonshine-host`. Nada aqui é afirmado como concluído sem
evidência nesse hardware.
