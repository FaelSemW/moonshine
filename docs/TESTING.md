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

**Esperado:** mensagens `OK` para Node.js, Sunshine, **helper de isolamento
autorizado** e serviço. Ao final, o endereço do painel. Confirme:

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

3. Convide o amigo para a sua rede Tailscale; ele instala o Tailscale no
   celular/PC dele.
4. No app dele: endereço `http://<ip-tailscale-do-bazzite>:48100` → **Entrar com
   código** → colar o convite → jogar.

**Esperado:** streaming funciona de fora da sua rede; nada ficou exposto à
internet pública (verifique em `tailscale status` que só a sua rede acessa).

---

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
