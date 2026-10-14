# Guia de Teste — de Ponta a Ponta (hoje)

Este é o roteiro objetivo para você testar o Moonshine na sua máquina Bazzite.
Cada etapa diz o que executar e o que você deve **ver** para confirmar sucesso.
Se algo falhar, o que enviar para eu corrigir está no final.

## Visão do fluxo

```
[Bazzite HOST]  Moonshine (Node+SQLite)  ←controle→  Painel (navegador/Android)
      │                                                    │
      └─ Sunshine (Flatpak) ←streaming real (vídeo/áudio/controles)→ Moonlight
```

- **Controle** (quem joga, quando, limpeza) = Moonshine.
- **Streaming** (o jogo em si) = Moonlight ↔ Sunshine (real, não simulado).

---

## Etapa 1 — Instalar o HOST na Bazzite

No **Desktop Mode**:

```bash
curl -fsSL https://raw.githubusercontent.com/FaelSemW/moonshine/main/deploy/bazzite/install.sh | bash
```

No meio da instalação aparece **um único pedido de sudo**: autorizar o helper
de isolamento (`moonshine-helper.sh`) — é o que permite criar/remover o
usuário dedicado da sessão de jogo. Recusar não quebra a instalação: só o
modo `game` fica indisponível (o modo `full` funciona normalmente).

**Esperado:** mensagens `OK` para Node.js, Sunshine, **Tailscale** (instalado
pelo próprio script se ausente), **helper de isolamento autorizado** e serviço.
Ao final, o endereço do painel. Confirme:

```bash
sudo -l | grep moonshine-helper   # deve listar .../deploy/bazzite/moonshine-helper.sh
```

## Etapa 2 — Diagnóstico

```bash
node ~/moonshine/host/src/cli.js doctor
```

**Esperado:**
- `"bazzite": true`
- `"fornecedorGPU": "amd" | "nvidia" | "intel"` (não `unknown`)
- `"acessivel": true` no bloco Sunshine (o Sunshine está respondendo)
- `Resultado: OK — Sunshine acessível`

Se `acessivel: false`, abra o Sunshine (Flatpak) e rode de novo.

## Etapa 3 — Configurar o Sunshine

```bash
node ~/moonshine/host/src/cli.js setup-sunshine
```

Informe o usuário/senha da Web UI do Sunshine (você define no primeiro setup do
Sunshine). Ele garante o app "Desktop" e mostra como parear.

## Etapa 4 — Subir o painel e criar o administrador

O serviço já está no ar. Abra `http://127.0.0.1:48100` (ou o endereço Tailscale).

**Esperado:** tela **Configuração inicial** → crie o administrador.

Depois entre e confira, na aba **Sunshine**, que "Alcançável" está **sim**.

## Etapa 5 — Gerar um código de convite

Painel → aba **Convites** → escolha o **modo** (`game` = sessão isolada ou
`full` = PC completo), usos e validade → **Gerar código** → **Copiar código**.

**Esperado:** aparece um código `XXXXX-XXXXX` na lista, com status **ativo**, e
um jogador `jogador-xxxxxx` é criado automaticamente (ou vincule o código a um
jogador existente).

Também dá para criar um jogador manualmente (aba **Jogadores** ou CLI):

```bash
node ~/moonshine/host/src/cli.js create-user jogador1 sua-senha-8
```

## Etapa 6 — Parear (automático nos apps Moonshine)

**Com os apps Moonshine** (Android/Windows — baixe os artefatos do CI):

1. Abra o app, informe o endereço do HOST (ex.: `http://<ip-do-bazzite>:48100`)
   e entre com o **código de convite**.
2. Na primeira vez, o app adiciona o host e **pareia sozinho**: o PIN é gerado
   pelo próprio app e entregue ao HOST — **você não digita nada**.

**Esperado:** pareamento concluído e o host aparece pareado, sem diálogo de PIN.

**Com o Moonlight oficial** (fluxo manual, continua disponível):

1. Instale o **Moonlight** (Google Play / flathub / site) e adicione o host
   (descoberta automática ou "Add computer" com o IP).
2. O Moonlight mostra um **PIN**; no painel Moonshine → aba **Sunshine** →
   **Pareamento** → digite o PIN → **Enviar**.

## Etapa 7 — Jogar (streaming real)

1. No app Moonshine, entre com o **código de convite** (ou com usuário/senha de
   jogador — esse caminho é sempre modo `game`).
2. Veja o PC **disponível** → toque **Iniciar sessão**.
3. O app reserva, prepara e abre o streaming (o app embute o Moonlight). Na
   **web/PWA**, o painel mostra o endereço do host para abrir no Moonlight.
4. **Esperado:** a tela do Bazzite aparece no dispositivo. Abra a Steam com a
   **sua conta** (o Moonshine não toca credenciais da Steam) e jogue.

## Etapa 8 — Encerrar e verificar a limpeza

1. No Moonlight, saia do streaming; e/ou no painel toque **Encerrar sessão**.
2. **Esperado:** o painel volta a **disponível** e registra a limpeza.
3. Confira que o ambiente temporário foi descartado:

```bash
ls -la /var/tmp/moonshine-sessions                 # deve ficar vazio
getent passwd | grep msplayer || echo "nenhum usuário de sessão restante"
```

**Esperado:** diretório vazio **e** nenhum `msplayer-*` em `/etc/passwd`. Se
sobrar lixo de uma limpeza falha, recupere com:

```bash
sudo ~/moonshine/deploy/bazzite/moonshine-helper.sh release <dir>
rm -rf <dir>
```

4. Confira os registros: painel → aba **Registros** (eventos + tentativas de login).

## Etapa 9 — Testar a trava de sessão simultânea

Com uma sessão ativa, tente reservar de outro dispositivo/usuário.

**Esperado:** recusa com "A máquina está ocupada".

## Etapa 10 — Testar recuperação (limpeza falha → locked)

Se uma limpeza falhar, o painel mostra **Bloqueado** e recusa novas sessões até
você usar **Liberar máquina** (aba Estado) ou `node host/src/cli.js unlock`.

## Etapa 11 — Modo PC completo (convite `full`)

1. **Convites** → modo **PC completo** → gerar → copiar.
2. Entre no app/web com esse código → **Iniciar sessão** → no Moonlight, escolha
   o app **Desktop**.

**Esperado:** o jogador vê e controla o **desktop do dono** (teclado/mouse e
arquivos reais), sem ambiente isolado — é a escolha deliberada do dono para
esse código. Confira na aba **Registros** o evento "modo PC completo".

Depois teste o revogar: **Convites** → **Revogar** → novo resgate do mesmo
código é recusado (401).

## Etapa 12 — Online para um amigo (Tailscale, sem internet pública)

O instalador (Etapa 1) já garante o Tailscale nos dois lados do desenho: no
HOST (Flatpak, instalado pelo script) e no app do jogador (VPN embutida no
próprio app Moonshine — ver Etapa 13). Falta só o **login** sua conta:

0. Abra o app **Tailscale** no Bazzite e faça login (uma vez, conta sua).
1. Painel → aba **Configuração** → passo **3 · Rede para amigos (Tailscale)** →
   **Expor painel no IP Tailscale** (isso aponta painel **e Sunshine** ao IP
   100.x do Bazzite) → reinicie o serviço.
2. No terminal do Bazzite (o painel já mostra o comando com o prefixo certo —
   Flatpak ou binário):

```bash
# Flatpak (padrão do Bazzite):
flatpak run --command=tailscale com.tailscale.tailscale serve --bg --https=443 http://127.0.0.1:48100
# Binário instalado no sistema:
tailscale serve --bg --https=443 http://127.0.0.1:48100
```

3. Convide o amigo para a sua rede Tailscale. **Hoje** (antes do suporte
   embutido nos apps) ele instala o Tailscale no celular/PC dele e entra na
   sua rede; quando o modo online estiver nos apps, ele instala **só o
   Moonshine** (Etapa 13).
4. No app dele: endereço `http://<ip-tailscale-do-bazzite>:48100` → **Entrar com
   código** → colar o convite → jogar.

**Esperado:** streaming funciona de fora da sua rede; nada ficou exposto à
internet pública (verifique em `tailscale status` que só a sua rede acessa).

---

## Etapa 13 — Modo online embutido (VPN dentro dos apps)

O dono configura **uma vez**; depois, o jogador usa **só o app Moonshine** —
a VPN privada vai embutida nele (sem instalar Tailscale no celular/PC do
jogador).

1. No admin do Tailscale (`login.tailscale.com/admin/settings/keys`) →
   **Generate auth key**: marque **expiração** (ex.: 90 dias) e a tag
   `moonshine` (crie a tag no **Access Controls** e restrinja `tag:moonshine`
   às portas do Sunshine — ver `SECURITY.md`).
2. Painel → passo **3 · Rede** → bloco **VPN embutida nos apps (modo
   online)** → cole a chave → **Salvar chave**. O painel passa a mostrar
   "chave configurada" (o valor nunca volta a aparecer).
3. Verifique a entrega da chave — ela só sai em `prepare`, com sessão de
   jogador ativa (o app faz isso sozinho):

```bash
curl -s http://127.0.0.1:48100/api/session/prepare \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sessionId\": $SID}"
```

   A resposta inclui `"online": {"authKey": "tskey-auth-...", "controlUrl":
   null}`. Já `/api/admin/network` (painel) mostra apenas
   `"configured": true` — nunca o valor.

4. **Apps**: o suporte embutido já está implementado. Com a chave configurada,
   a aba Convites emite o **código online** (`MS1-...`) — um único código que o
   jogador cola no app (Android ou Windows). O app decodifica, entra na
   rede privada sozinho e só então resgata o convite. Fluxo de validação na
   Etapa 14.
5. Desativar/rotacionar: painel → **Desativar modo online**, ou gere outra
   chave no Tailscale e cole por cima (rotação). Códigos `MS1-` antigos
   carregam a chave antiga — gere convites novos após rotacionar.

---

## Etapa 14 — Validar o modo online NOS APPS (VPN embutida)

Com o HOST no ar e a chave configurada (Etapa 13):

1. Painel → **Convites** → gere um convite. Com a chave configurada, a lista
   mostra o **código online** (`MS1-...`) — use **Copiar (app)**.
2. **Android** (aparelho com internet, FORA da rede local do HOST):
   - instale o APK do artefato `moonshine-client-android`;
   - cole o código online no campo "Código de convite" → **Entrar com código**;
   - o app pede **1 permissão de VPN** (uma vez por aparelho) → autorize;
   - status: "Rede privada ativa." → "Conectado como ...";
   - **Jogar**: reserva → prepara → Moonlight abre com o host `100.x`;
     pareie (automático) e confirme o **streaming real**.
3. **Windows** (PC externo, só internet):
   - execute o `.exe` do artefato `moonshine-client-windows-x64`;
   - cole o mesmo código online → **Entrar com código**;
   - se o Tailscale não existir no PC, o app baixa o instalador **oficial**
     (assinatura Authenticode verificada — só "Tailscale Inc" passa) e pede
     **uma elevação UAC** para instalar em silencioso;
   - depois entra na rede sozinho ("Rede privada ativa.") e o fluxo segue:
     reserva → Moonlight → streaming.
4. **Fim**: "Encerrar sessão"/"Sair" → o app sai da rede privada (Android
   derruba o túnel; Windows roda `tailscale logout`, deixando o PC do amigo
   como estava — o Tailscale instalado permanece, inativo).
5. Se falhar: anote a mensagem exata do app (ela diz se parou na chave, na
   VPN ou no streaming) e rode o `curl` de conferência do item 3 da Etapa 13.

## O que enviar se algo falhar

Rode e me mande a saída:

```bash
node ~/moonshine/host/src/cli.js doctor
journalctl --user -u moonshine-host -n 100 --no-pager
systemctl --user status moonshine-host
```

E descreva: em qual etapa parou e qual mensagem apareceu. Com isso eu corrijo.

## O que este teste NÃO depende de mim

- Streaming/GPU/isolamento só se confirmam no seu hardware (daí o `doctor`).
- Saves na nuvem (Steam Cloud) não são apagáveis por este sistema (limite real,
  explicado em `docs/SECURITY.md`).
