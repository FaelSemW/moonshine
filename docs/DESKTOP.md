# Cliente Desktop Windows/Linux (Moonshine + Moonlight embutido)

O app desktop do Moonshine é um **fork do moonlight-qt** (Moonlight oficial,
Qt 6 / QML) com uma tela de controle do Moonshine **à frente**: login →
reservar sessão → preparar → o app registra o Sunshine no Moonlight embutido e
entra na tela de PCs normal (pareamento na 1ª vez) e streaming. Tudo acontece
**no mesmo executável** — não há app externo.

- Código em: `client/desktop/`
- Licença: **GPL-3.0** (código-fonte integral publicado neste repositório)
- Arquiteturas: `moonlight-common-c`, `qmdnsengine`, `SDL_GameControllerDB`
  são submódulos fixados nos SHAs oficiais do moonlight-qt.
- O que mudamos em relação ao upstream: `backend/moonshinebackend.{h,cpp}`
  (controle HTTP do HOST: login, resgate de código, reserva, heartbeat, modo e
  auto-pair), `gui/MoonshineLogin.qml` (tela de controle com **entrada por
  código de convite**), costura de auto-pareamento em
  `backend/nvpairingmanager.{h,cpp}` (PIN entregue ao HOST entre `getservercert`
  e `clientchallenge`) e `gui/PcView.qml` (diálogo de PIN omitido quando há
  sessão Moonshine), registro em `app.pro`/`qml.qrc`, tela inicial trocada no
  `main.cpp`, e a etapa MSI/WiX removida do `scripts/build-arch.bat` (distribuímos
  a pasta portátil, não um instalador). Com o modo online: `backend/onlinecode.{h,cpp}` (decodificação
   do código `MS1-`) e `backend/onlinevpn.{h,cpp}` (VPN embutida via cliente
   oficial do Tailscale).

## Fluxo do jogador

1. Abre o app → tela **Moonshine**: entra com o **código de convite** (aba
   Convites do painel). Com o modo online configurado, use o **código online**
   (`MS1-...`) — ele carrega sozinho o endereço do HOST na rede privada e a
   chave da VPN embutida (sem digitar endereço nem instalar Tailscale). Sem
   modo online, informe o endereço do HOST à mão (ex.:
   `http://192.168.0.10:48100`). (Alternativa: usuário/senha de jogador —
   modo `game`.)
2. **Jogar** → reserva e prepara a sessão no HOST; o modo concedido
   (`game` isolado / `full` PC completo) aparece no status.
3. Na **1ª vez** o Moonlight **pareia sozinho** (PIN entregue ao HOST
   automaticamente — nada para digitar). Escolhe o host, o jogo (ou o app
   **Desktop**, no modo `full`) e inicia o stream.
4. Fechar o app encerra a sessão no HOST (e o HOST limpa o ambiente); no
   modo online o app também **sai da rede privada** (`tailscale logout`).

## VPN embutida (modo online — Tailscale real no Windows)

O app dirige o **cliente oficial do Tailscale** no Windows — o jogador não
instala nem configura nada à mão:

1. Com um código `MS1-`, o app decodifica endereço + chave e, se o Tailscale
   não existir no PC, **baixa o instalador oficial**
   (`pkgs.tailscale.com/stable`, versão fixada no código), **verifica a
   assinatura Authenticode** (só "Tailscale Inc" passa) e instala em silencioso
   com **uma elevação UAC** (`ShellExecuteW runas` + `msiexec /qn`).
2. Depois dirige a CLI: `tailscale up --authkey=... --accept-dns=false
   --accept-routes=false` (sem mexer no DNS/rotas do PC do jogador) e espera
   `Running` via `tailscale status --json`.
3. Com o TUN ativo, o `100.x` do HOST é roteado normalmente — o código de
   streaming do Moonlight **não muda nada**.
4. "Encerrar sessão"/"Sair" → `tailscale logout` (o PC volta ao estado
   normal; o Tailscale instalado permanece, inativo). Se o PC **já estava**
   em outra rede Tailscale, o app avisa e não mexe na sessão alheia.
5. No Linux/macOS (mesmo código): usa o `tailscale` do sistema se existir;
   sem elevação interativa, instrui (`sudo tailscale up`) e falha com
   mensagem clara se não houver permissão.

## Compilar (CI — recomendado)

O workflow **Cliente Desktop** (`.github/workflows/desktop.yml`) compila em
cada push que altera `client/desktop/` e publica o pacote portátil como
artefato **`moonshine-client-windows-x64`** (pasta com `Moonlight.exe`
renomeado + DLLs, ~37 MB).

Receita usada (idêntica ao moonlight-qt upstream): `windows-2025` + Qt
`6.12.0` + `setup-deps.ps1` (deps pré-compiladas) + `scripts/build-arch.bat
Release x64` (chama `vcvarsall` sozinho; `windeployqt` gera a pasta).

## Compilar localmente (Windows)

Requisitos: Windows 10/11 x64, Visual Studio 2022+ (C++), Qt 6.12 (MSVC),
`git`, PowerShell.

```powershell
git clone --recurse-submodules https://github.com/FaelSemW/moonshine
cd moonshine\client\desktop
powershell .\setup-deps.ps1        # baixa libs\windows (deps pré-compiladas)
# Abra um "Qt Command Prompt" (MSVC) e rode:
scripts\build-arch.bat Release x64
```

Saída: `build\deploy-x64-release\` (pasta portátil). Execute o `.exe` de lá.

> Nota: como todo app Qt no Windows, o programa é uma **pasta** com o
> executável + DLLs (Qt, FFmpeg, SDL2 etc.), não um `.exe` avulso. O jogador
> usa a pasta como um único app.

## O que ainda precisa de teste em hardware real

O CI compila e gera o pacote, mas o **streaming em si** precisa de um PC
Windows real, codec de vídeo compatível e um HOST Bazzite com Sunshine.
Ver `docs/ACCEPTANCE.md` para a lista do que validar em hardware.
