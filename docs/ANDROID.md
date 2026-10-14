# Cliente Android (Moonshine + Moonlight embutido)

O app Android do Moonshine é **um único APK**: a tela de controle da plataforma
(login → reserva de sessão → stream) **e** o streaming real, feito pelo código do
Moonlight (moonlight-android + moonlight-common-c) que roda dentro do mesmo app.
Não há app externo: o vídeo, áudio e controles são do Moonlight oficial,
embutido.

- `applicationId`: `com.moonshine.client` (nunca `com.limelight` — pedido dos
  mantenedores Moonlight).
- Licença: **GPL-3.0** (código-fonte integral publicado neste repositório).

## Fluxo do jogador

1. Abre o app, informa o **endereço do HOST** (ex.: `http://192.168.0.10:47990`,
   ou o IP Tailscale para jogar fora de casa).
2. **Entrar** com o usuário/senha de jogador (criados no painel do HOST).
3. **Jogar (reservar sessão)** — reserva e prepara a sessão no HOST.
4. Na **1ª vez**, o Moonlight pede para **parear**: um PIN aparece e você digita
   no Sunshine (painel do HOST → Sunshine). Depois, escolhe o host e inicia o
   stream.
5. **Encerrar sessão** libera o PC. Só **um jogador por vez**.

## Compilar

### Opção A — Android Studio (recomendado)

1. `git clone --recurse-submodules https://github.com/FaelSemW/moonshine`
2. Android Studio → **Open** → pasta `client/android`.
3. Deixe o Gradle sincronizar (baixa o NDK automaticamente).
4. **Run ▶** em um dispositivo/emulador, ou **Build → Build APK(s)**.

### Opção B — linha de comando

Requisitos: JDK 17, Android SDK, NDK `29.0.14206865`, `git`.

```bash
git clone --recurse-submodules https://github.com/FaelSemW/moonshine
cd moonshine/client/android
./gradlew assembleNonRootDebug          # macOS/Linux
# .\gradlew.bat assembleNonRootDebug     # Windows
```

APK gerado em:

```
app/build/outputs/apk/nonRoot/debug/app-nonRoot-debug.apk
```

Instale no aparelho:

```bash
adb install -r app/build/outputs/apk/nonRoot/debug/app-nonRoot-debug.apk
```

## Compilação contínua (CI)

O workflow **Cliente Android** (`.github/workflows/android.yml`) compila o APK a
cada push que altera `client/android/` e publica o `.apk` como artefato do
GitHub Actions. É a prova de que o código constrói.

## O que ainda precisa de teste em aparelho real

O CI compila, mas o **streaming em si** precisa de um dispositivo Android com
codec de vídeo compatível e um HOST Bazzite real rodando Sunshine. Ver
`docs/ACCEPTANCE.md` para a lista do que validar em hardware.
