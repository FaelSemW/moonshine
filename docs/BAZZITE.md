# Instalação, Configuração e Recuperação no Bazzite

Guia do HOST no **Bazzite** (Fedora Atomic / ostree). A raiz do sistema é
**imutável**: não se instala pacotes de sistema com `dnf`. Este guia respeita
isso.

## Visão do que o HOST precisa

| Componente | Como obtido no Bazzite | Por quê |
|---|---|---|
| Node.js | Binário oficial em `~/.local/bin` (sem root) | Roda o serviço de controle |
| Sunshine | Flatpak oficial `dev.lizardbyte.app.Sunshine` | Servidor de streaming |
| Serviço | User unit do systemd (`~/.config/systemd/user`) | Autostart sem sudo |
| Helper de isolamento | `deploy/bazzite/moonshine-helper.sh` + `/etc/sudoers.d/moonshine-isolation` (único sudo, opcional) | Criar/remover o usuário da sessão no modo `game` |
| Rede | Tailscale (Flatpak/binário) + Tailscale Serve | Acesso remoto privado |

Nada disso altera a raiz imutável.

## Instalação (Desktop Mode)

1. No terminal do Desktop Mode do Bazzite, rode o instalador de um comando só —
   ele baixa o código para `~/moonshine` e instala tudo:

```bash
curl -fsSL https://raw.githubusercontent.com/FaelSemW/moonshine/main/deploy/bazzite/install.sh | bash
```

(Alternativa, se você já clonou o repo na mão: `bash ~/moonshine/deploy/bazzite/install.sh`.)

O script:
- instala Node.js local se ausente;
- baixa o código para `~/moonshine`;
- instala/ativa o Sunshine via Flatpak;
- instala o **Tailscale** via Flatpak se ausente (rede privada — os dois
  lados precisam dele: este HOST e o app do jogador, cuja VPN vai embutida
  no próprio app Moonshine);
- **pede um único sudo** para autorizar o helper de isolamento
  (`/etc/sudoers.d/moonshine-isolation` — só o `moonshine-helper.sh` do
  serviço é autorizado; recusar mantém tudo funcionando menos o modo `game`);
- registra e habilita a user unit `moonshine-host.service`;
- imprime os próximos passos do Tailscale (login no app + comando serve).

2. Confirme o helper: `sudo -l | grep moonshine-helper`.
3. Abra `http://127.0.0.1:48100` e crie o administrador.

## Sunshine no Bazzite

O Sunshine é distribuído como Flatpak. Após instalar, é preciso **conceder
permissões** e fazer o pareamento:

- Abra o Sunshine (Flatpak) e conclua o setup inicial (usuário/senha da Web UI).
- O Moonshine pode ler o estado do Sunshine pela porta GameStream HTTP `47989`
  (endpoint `/serverinfo`), que **não** exige pareamento.
- **Pareamento:** com os **apps Moonshine** o PIN é gerado no app e entregue ao
  HOST automaticamente (auto-pair, sem digitar nada); com Moonlight oficial o
  PIN continua manual (exibido no painel, aba **Sunshine**).

### Permissões de GPU (AMD/NVIDIA/Intel)

Confirme que o Sunshine consegue codificar (VA-API para AMD/Intel, NVENC para
NVIDIA). No Bazzite, drivers de GPU e codecs geralmente já vêm preparados para
jogos; verifique no painel do Sunshine.

## Rede privada (Tailscale)

O HOST escuta em **loopback** por padrão. Para acessar de fora:

```bash
flatpak install -y flathub com.tailscale.tailscale
```

Use o **Tailscale Serve** para expor o painel Moonshine com HTTPS no endereço
Tailscale, e aponte o cliente para esse endereço. **Não** publique o painel na
internet pública nem abra portas administrativas desnecessárias.

O **CLI do Tailscale Flatpak** fica dentro do sandbox — prefixe com
`flatpak run --command=tailscale com.tailscale.tailscale`:

```bash
flatpak run --command=tailscale com.tailscale.tailscale serve --bg --https=443 http://127.0.0.1:48100
```

O painel detecta as duas formas (binário ou Flatpak) e já exibe o comando com
o prefixo certo no passo 3 do assistente.

### VPN embutida nos apps dos jogadores (modo online)

Depois da rede ativa, gere uma **auth key** em
`login.tailscale.com/admin/settings/keys` (com tag `moonshine` e expiração) e
cole no painel (passo 3 → **VPN embutida nos apps**). Os apps Moonshine
(Android/desktop) usam essa chave para entrar sozinhos na rede privada — o
jogador **não instala Tailscale**. Restrinja `tag:moonshine` no ACL às portas
do Sunshine (ver `SECURITY.md`).

Com a chave configurada, a aba Convites passa a emitir o **código online**
(`MS1-...`): um único código que já contém convite + endereço do HOST na rede
+ chave — o app do amigo cola e entra, sem digitar mais nada. Se o `tailscale
ip -4` não for detectável no contexto do serviço (ex.: só acessível pela GUI
Flatpak), fixe o IP por `MOONSHINE_TAILSCALE_IP=x.y.z.w` no ambiente do
serviço `moonshine-host`.

O streaming (Sunshine) usa as portas GameStream/vídeo/áudio/RTSP, que trafegam
sobre a mesma rede privada (o passo 3 também aponta `sunshineAddress` ao IP
Tailscale, para o Moonlight dos jogadores conectar de lá).

## Autostart

A user unit `moonshine-host.service` fica `WantedBy=default.target` e sobe com o
login do usuário. O Sunshine Flatpak tem seu próprio unit gerenciado pelo
Flatpak. Mantenha o PC ligado e conectado à rede para ficar disponível.

## Recuperação

### Máquina travada (`locked`)

Se uma sessão terminar com limpeza incompleta, o HOST fica `locked` e recusa
novas sessões. Para recuperar:

1. Abra o painel como administrador.
2. Aba **Estado** → **Liberar máquina** (ou `POST /api/admin/machine/unlock`).
3. Confirme que verificou que nenhum dado sensível do jogador restou.

Você também pode limpar manualmente (o helper devolve a propriedade do
diretório ao serviço para o `rm` funcionar):

```bash
ls -la /var/tmp/moonshine-sessions   # deve ficar vazio entre sessões
getent passwd | grep msplayer        # não deve sobrar usuário de sessão
# se sobrou lixo de uma falha:
sudo ~/moonshine/deploy/bazzite/moonshine-helper.sh release /var/tmp/moonshine-sessions/<dir>
rm -rf /var/tmp/moonshine-sessions/<dir>
# processos órfãos de uma sessão (se houver):
ps -u msplayer-XXXXXX                # lista processos do usuário dedicado
sudo ~/moonshine/deploy/bazzite/moonshine-helper.sh kill msplayer-XXXXXX
```

### Reinstalação do serviço

```bash
systemctl --user disable --now moonshine-host.service
bash ~/moonshine/deploy/bazzite/install.sh
```

### Dados do HOST

O banco e a configuração ficam em `~/.local/share/moonshine`. Para resetar
totalmente (apaga usuários e sessões), pare o serviço e remova esse diretório.

## Limitações conhecidas (Bazzite)

- **Modo `game` exige o sudo único do helper:** sem a regra
  `/etc/sudoers.d/moonshine-isolation`, o prepare da sessão isolada falha com
  mensagem clara; o modo `full` (PC completo) não é afetado. Revogar:
  `sudo rm /etc/sudoers.d/moonshine-isolation`.
- **Runtime do modo `game` (fase 2):** os apps/jogos do Sunshine ainda são
  lançados na conta do dono — identidade isolada e limpeza são reais, mas o
  isolamento de input completo depende da fase 2 (ver
  [SECURITY.md](SECURITY.md) "Limites honestos").
- **`sessionRuntimeDir` fixo no helper:** o `moonshine-helper.sh` só aceita
  `/var/tmp/moonshine-sessions/...`; mudar a configuração exige ajustar as
  regexes do helper.
- O caminho **VFIO/GPU-passthrough** e a criação automática de ambiente com
  isolamento forte dependem de hardware e privilégios que **não foram validados**
  neste ambiente de desenvolvimento (Windows). Ver [ACCEPTANCE.md](ACCEPTANCE.md).
- Jogos que gravam em diretórios protegidos da Steam podem ter comportamento
  variável numa biblioteca somente-leitura; restrinja caso a caso.
- Saves sincronizados na nuvem não são apagáveis por este sistema.
