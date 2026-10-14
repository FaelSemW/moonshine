# Modelo de Segurança e Isolamento de Sessões

Este documento descreve as decisões de segurança do Moonshine Cloud Gaming e os
seus limites reais. Não promete proteção que a arquitetura não oferece.

## Princípio central

O jogador recebe um **ambiente temporário isolado** que não expõe os dados
privados do proprietário nem de outros jogadores. O ambiente de sessão usa
**identidade de segurança própria** (usuário dedicado), nunca a conta do
proprietário, e o jogador **nunca** recebe acesso administrativo.

**Limitação de runtime declarada (fase 2):** os apps/jogos do Sunshine ainda
são lançados na conta do proprietário. Até a fase 2 — rodar o streaming dentro
da sessão do usuário dedicado — o modo `game` **não** afirma isolamento de
input contra o dono da máquina; ele afirma e entrega a identidade isolada, o
HOME descartável e a limpeza verificada. Ver "Limites honestos".

## Estratégia de isolamento (Linux/Bazzite)

Para cada sessão o HOST usa um **usuário Linux dedicado** (ex.: `msplayer-a1b2`):

1. O usuário dedicado é criado com `useradd --create-home
   --home-dir /var/tmp/moonshine-sessions/s<id>-<rand>/home
   --shell /usr/sbin/nologin`. O `HOME` temporário vai direto para o
   `/etc/passwd` do usuário — nada é criado em `/home`.
2. O `HOME` desse usuário é um diretório temporário sob
   `/var/tmp/moonshine-sessions/s<id>-<rand>`, com permissões `0700`, e todo o
   diretório da sessão passa a pertencer ao usuário dedicado.
3. O jogador opera **como esse usuário**, não como o proprietário. Os arquivos
   pessoais do proprietário pertencem a outro usuário com permissões que não
   concedem leitura ao jogador.
4. A **biblioteca de jogos permanente** é exposta **somente leitura** (bind
   mount `ro` ou permissão de leitura). O jogador não modifica os jogos.
5. Saves/caches/configurações da sessão são gravados no HOME temporário.

Ao final da sessão (passos 8–12 do ciclo):

6. Os processos do usuário dedicado são terminados (`pkill -u`).
7. A propriedade do diretório da sessão é **devolvida ao serviço** (`release`)
   e então o `HOME` temporário é removido (`rm -rf`), **após validação
   canônica** de que o caminho está sob o escopo autorizado.
8. O usuário dedicado é removido (`userdel --remove`).
9. Verifica-se que o diretório não existe mais e que nenhum processo sobreviveu.
10. **Somente após verificação OK** a máquina volta a `available`.

### Privilégio: helper restrito (Bazzite)

O serviço roda como `systemd --user` — **sem root** — mas `useradd`,
`userdel`, `chown` e `pkill` de outro usuário exigem privilégio. A instalação
resolve isso com **um único sudo, opcional e explícito**:

- `deploy/bazzite/moonshine-helper.sh` é o **único portão para root**. Ele
  valida toda entrada por regex estrita antes de qualquer comando (nome de
  usuário `msplayer-<6 hex>`, diretório
  `/var/tmp/moonshine-sessions/s<id>-<8 hex>`), fixa os flags internamente e
  recusa tudo o que estiver fora do padrão com exit 64.
- O `install.sh` grava `/etc/sudoers.d/moonshine-isolation` autorizando
  **só o usuário do serviço** e **só esse script** (validado com `visudo -c`).
- O HOST chama o helper via `sudo -n` — nunca interativo. Sem a regra sudoers,
  o prepare do modo `game` falha com mensagem clara (o modo `full` não é
  afetado).
- Para revogar: `sudo rm /etc/sudoers.d/moonshine-isolation`.
- Recuperação manual de lixo (sessão que deixou diretório para trás):
  `sudo ~/moonshine/deploy/bazzite/moonshine-helper.sh release <dir> && rm -rf <dir>`.

> Se você mudar `sessionRuntimeDir` na configuração, ajuste também as regexes
> do helper — ele só aceita o root padrão `/var/tmp/moonshine-sessions`.

### Por que usuário dedicado e não só um diretório?

Um diretório separado, isolado, **não** é fronteira de segurança: o processo do
jogador ainda rodaria como o proprietário e poderia ler qualquer arquivo legível
pelo proprietário (chaves, saves, navegador, Steam). Usuário dedicado muda a
**identidade de segurança** do processo, que é a fronteira real do SO.

## Se a limpeza falhar

Se a verificação pós-limpeza encontrar diretório remanescente ou processo
sobrevivente, a máquina entra em estado **`locked`** e **não aceita novas
sessões** até o administrador fazer a recuperação manual
(`POST /api/admin/machine/unlock`). O produto prefere ficar indisponível a
arriscar vazar dados entre jogadores.

## Limites honestos desta primeira versão

- **Identidade em runtime (fase 2):** o Sunshine lança os apps/jogos na conta
  do **proprietário**. O usuário dedicado, o HOME descartável e o ciclo de
  limpeza existem e são reais, mas o processo do jogo em si ainda corre sob o
  dono — logo, o modo `game` **não** impede que o jogador, através do input do
  streaming, aja sobre a sessão do dono. Rodar o streaming dentro da sessão do
  usuário dedicado (ex.: sessão Gamescope por sessão) é o trabalho da fase 2 e
  é requisito para afirmar isolamento completo. O modo `full` não sofre dessa
  ressalva: ele é, por definição, o desktop real do dono.
- **Saves na nuvem (Steam Cloud):** dados sincronizados com serviços externos
  (Steam Cloud, contas de terceiros) **não são apagáveis** pelo HOST. Continuam
  sujeitos aos termos do próprio serviço. O Moonshine não promete o contrário.
- **Steam:** o jogador usa a **interface oficial da Steam** com a **própria
  conta**. O Moonshine **não** coleta, armazena nem transmite credenciais da
  Steam. A senha da plataforma ≠ senha da Steam.
- **Biblioteca compartilhada:** jogos que gravam em diretórios protegidos podem
  ter comportamento variável; quando não é possível garantir segurança, a
  funcionalidade é restrita e documentada (ver `BAZZITE.md`).
- **Windows (desenvolvimento):** o modo `temp-home` usa um diretório temporário
  **sem** isolamento de SO. Não é adequado para jogadores não confiáveis; serve
  apenas para validar o plano de controle.
- **Privilégio opcional:** sem a regra sudoers do helper (instalação sem
  sudo), o modo `game` não inicia (falha explícita no prepare); o modo `full`
  continua funcional.

## Segurança da API de controle

- Escuta em **loopback** por padrão; exposta na rede privada via **Tailscale
  Serve** (HTTPS). Nunca diretamente à internet pública.
- Senhas com **scrypt** (salt por usuário), nunca texto claro.
- Tokens de sessão: 256 bits aleatórios, gravados apenas como **SHA-256** no
  banco; revogáveis a qualquer momento (logout, desativação de usuário).
- **Rate limit** de login: após 5 falhas numa janela de 15 min, bloqueio (429).
- Nenhuma rota executa comando arbitrário vindo da rede. Nenhuma rota aceita
  caminho de arquivo do cliente.
- Cabeçalhos de segurança (`nosniff`, `X-Frame-Options: DENY`, etc.) em toda
  resposta. Corpo limitado a 64 KB.
- Máquina impede **sessão simultânea**: reserva atômica, um jogador por vez.

## Acesso por código de convite e modos de sessão

- O administrador gera **códigos de convite** no painel (aba **Convites**):
  10 símbolos em base32 de Crockford (`XXXXX-XXXXX`, 50 bits de entropia), com
  validade opcional, limite de usos e **modo**. Revogar (ou esgotar/expirar)
  corta o acesso.
- **O código É a credencial** do jogador — não existe senha de plataforma para
  quem entra por convite. O resgate (`POST /api/redeem`) tem **rate limit por
  IP** (20 tentativas/min) e só aceita código ativo, não expirado e não
  esgotado; o consumo do uso é atômico (dois resgates simultâneos não estouram
  o limite).
- O **modo da sessão vem do token**, nunca de input livre do cliente:
  - `game` — sessão isolada (seção acima). Todo login por senha é `game`.
  - `full` — PC completo: o dono deliberadamente abre o desktop real **sem**
    isolamento. Só obtível por convite emitido como `full`.
- **Auto-pareamento:** o PIN do pareamento GameStream é **gerado pelo cliente**
  (nossos apps Android/Windows) e entregue ao HOST (`POST /api/pair/pin`,
  autenticado, rate limit 10/min por IP), que o repassa à API oficial do
  Sunshine (`POST /api/pin`). O jogador não digita nem vê o PIN nos apps. Sem
  sessão Moonshine o fluxo volta ao oficial (PIN exibido/digitação no painel).

## Credenciais do Sunshine

O HOST pode guardar, **em memória de processo**, as credenciais da Web UI do
Sunshine para falar a API dele. Isso não são credenciais de jogador nem da Steam.
