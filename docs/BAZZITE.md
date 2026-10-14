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
| Rede | Tailscale (Flatpak/binário) + Tailscale Serve | Acesso remoto privado |

Nada disso altera a raiz imutável.

## Instalação (Desktop Mode)

1. No terminal do Desktop Mode do Bazzite (sem sudo no comando principal), rode o instalador de um comando só — ele baixa o código para `~/moonshine` e instala tudo:

```bash
curl -fsSL https://raw.githubusercontent.com/FaelSemW/moonshine/main/deploy/bazzite/install.sh | bash
```

(Alternativa, se você já clonou o repo na mão: `bash ~/moonshine/deploy/bazzite/install.sh`.)

O script:
- instala Node.js local se ausente;
2. O script:
- instala Node.js local se ausente;
- baixa o código para `~/moonshine`;
- instala/ativa o Sunshine via Flatpak;
- registra e habilita a user unit `moonshine-host.service`;
- imprime instruções do Tailscale.

3. Abra `http://127.0.0.1:48100` e crie o administrador.

## Sunshine no Bazzite

O Sunshine é distribuído como Flatpak. Após instalar, é preciso **conceder
permissões** e fazer o pareamento:

- Abra o Sunshine (Flatpak) e conclua o setup inicial (usuário/senha da Web UI).
- O Moonshine pode ler o estado do Sunshine pela porta GameStream HTTP `47989`
  (endpoint `/serverinfo`), que **não** exige pareamento.
- O pareamento do Moonlight com o Sunshine é feito pelo próprio Moonlight (PIN).
  O Moonshine exibe/gerencia isso no painel, mas não substitui o pareamento.

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

O streaming (Sunshine) usa as portas GameStream/vídeo/áudio/RTSP, que trafegam
sobre a mesma rede privada.

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

Você também pode limpar manualmente:

```bash
ls -la /var/tmp/moonshine-sessions   # deve ficar vazio entre sessões
# processos órfãos de uma sessão (se houver):
ps -u msplayer-*                     # lista processos do usuário dedicado
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

- O caminho **VFIO/GPU-passthrough** e a criação automática de ambiente com
  isolamento forte dependem de hardware e privilégios que **não foram validados**
  neste ambiente de desenvolvimento (Windows). Ver [ACCEPTANCE.md](ACCEPTANCE.md).
- Jogos que gravam em diretórios protegidos da Steam podem ter comportamento
  variável numa biblioteca somente-leitura; restrinja caso a caso.
- Saves sincronizados na nuvem não são apagáveis por este sistema.
