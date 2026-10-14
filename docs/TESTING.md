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

No **Desktop Mode**, sem sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/FaelSemW/moonshine/main/deploy/bazzite/install.sh | bash
```

**Esperado:** mensagens `OK` para Node.js, Sunshine e serviço. Ao final, o
endereço do painel.

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

## Etapa 5 — Criar um jogador

Painel → aba **Jogadores** → adicione (ex.: `jogador1` / senha de 8+ caracteres).

Ou pela CLI (com o serviço parado ou rodando):

```bash
node ~/moonshine/host/src/cli.js create-user jogador1 sua-senha-8
```

## Etapa 6 — Parear o Moonlight com o Sunshine

1. No celular/desktop, instale o **Moonlight** (Google Play / flathub / site).
2. Abra o Moonlight e **adicione o host** pelo endereço GameStream do Bazzite
   (descoberta automática na mesma rede, ou "Add computer" com o IP).
3. O Moonlight mostra um **PIN**. No painel Moonshine → aba **Sunshine** →
   **Pareamento** → digite o PIN → **Enviar**.

**Esperado:** "Pareamento concluído" e o cliente aparece como pareado.

## Etapa 7 — Jogar (streaming real)

1. No Moonlight (cliente), entre com `jogador1` / senha no painel Moonshine.
2. Veja o PC **disponível** → toque **Iniciar sessão**.
3. O painel reserva, prepara e mostra o **endereço do host** para abrir no
   Moonlight. Copie o endereço, abra o Moonlight e inicie o streaming.
4. **Esperado:** a tela do Bazzite aparece no dispositivo. Abra a Steam com a
   **sua conta** (o Moonshine não toca credenciais da Steam) e jogue.

## Etapa 8 — Encerrar e verificar a limpeza

1. No Moonlight, saia do streaming; e/ou no painel toque **Encerrar sessão**.
2. **Esperado:** o painel volta a **disponível** e registra a limpeza.
3. Confira que o ambiente temporário foi descartado:

```bash
ls -la /var/tmp/moonshine-sessions    # deve ficar vazio
```

4. Confira os registros: painel → aba **Registros** (eventos + tentativas de login).

## Etapa 9 — Testar a trava de sessão simultânea

Com uma sessão ativa, tente reservar de outro dispositivo/usuário.

**Esperado:** recusa com "A máquina está ocupada".

## Etapa 10 — Testar recuperação (limpeza falha → locked)

Se uma limpeza falhar, o painel mostra **Bloqueado** e recusa novas sessões até
você usar **Liberar máquina** (aba Estado) ou `node host/src/cli.js unlock`.

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
