# Relatório de Implementação — Moonshine Cloud Gaming

Data da primeira versão: 2026-10-12
Ambiente de desenvolvimento: Windows 11, Node.js 22.23.3, sem Python/Java/CMake/GPU.

> **Atualização 2026-10-14 — o corpo abaixo é o relato da primeira versão.**
> Mudanças posteriores (estado vigente em `README.md`/`ACCEPTANCE.md`/`SECURITY.md`):
> - **Códigos de convite** como credencial do jogador e **dois modos de sessão**
>   (`game` isolado / `full` PC completo), com modo vindo do token.
> - **Auto-pareamento**: o PIN é gerado no app e repassado ao Sunshine pela API
>   oficial (`POST /api/pair/pin`); sem sessão Moonshine, vale o PIN manual.
> - **Clientes Android e Windows com Moonlight EMBUTIDO** (forks compilados na
>   CI do GitHub Actions, artefatos publicados) — o item "cliente externo" da
>   seção 4 e o deep-link `moonlight://` (não existe no Moonlight oficial)
>   estão **superados**.
> - **Porta do HOST = 48100** (47990 é a Web UI do Sunshine).
> - **Helper de privilégio** `deploy/bazzite/moonshine-helper.sh` + sudoers
>   restrito (instalação com um único sudo, opcional): useradd/userdel/chown/
>   pkill do modo `game` funcionam sob `systemd --user`; ciclo real coberto por
>   teste na CI Linux. Limitação honesta de runtime (jogo ainda roda na conta do
>   dono até a fase 2) em `SECURITY.md`.
> - **39 → 41 testes** automatizados (`npm test`).

## 1. O que foi implementado (funcional e testado)

### HOST (Node.js, sem dependências externas) — `host/src/`

| Arquivo | Responsabilidade |
|---|---|
| `config.js` | Configuração validada em `data/config.json`, criada com padrões seguros |
| `db.js` | SQLite nativo: usuários, tokens, sessões, máquina, logs |
| `auth.js` | scrypt (salt/usuário), tokens SHA-256 revogáveis, rate limit de login |
| `probe.js` | Detecção de SO/Bazzite/GPU/RAM/ferramentas + relatório de compatibilidade |
| `sunshine.js` | Integração real com a API do Sunshine (`/serverinfo`, config API, close app) |
| `isolation.js` | Usuário dedicado, HOME temporário, descarte e verificação com validação de caminho |
| `session.js` | Ciclo de vida (reserva → preparar → ativa → limpeza → liberação) + máquina de estados |
| `server.js` | API de controle autenticada + painel admin + cliente, com segurança |
| `index.js` | Boot, estado inicial, polling de fim de sessão |

### Cliente web/PWA — `host/public/`

- Fluxo: setup → login → estado em tempo real (polling 2s) → reserva →
  streaming real via Moonlight (deep-link `moonlight://` em mobile) → encerrar.
- Painel administrativo integrado: estado, jogadores (CRUD), Sunshine, registros,
  diagnóstico, liberação de máquina travada.
- Interface moderna responsiva (variáveis CSS, cartões, badges, toasts, PWA).

### Implantação

- `deploy/bazzite/install.sh` — instalador para base imutável (Node local sem
  root, Sunshine via Flatpak, user unit do systemd).
- `deploy/bazzite/moonshine-host.service` — user unit endurecida.

### Testes — `tests/` (26 testes, todos passando)

- `test-auth.js` — hashing, verificação, token/revogação, força bruta, expiração.
- `test-isolation.js` — validação de caminho (traversal/symlink), criar/descartar
  ambiente, verificação de limpeza.
- `test-session.js` — reserva exclusiva, reconexão sem duplicar, ciclo completo,
  detecção de fim, máquina travada + unlock.
- `test-server.js` — integração HTTP: setup, login, estado, reserva, admin,
  bloqueio de traversal estático.

## 2. Decisões técnicas

- **Plano de controle separado do streaming.** A API do Sunshine **não** tem
  endpoint para *iniciar* app (só Moonlight via GameStream `/launch`). Logo, o
  Moonshine autoriza/reserva/prepara/limpa, e o Moonlight real faz o streaming.
  Nada foi simulado.
- **Node.js** como runtime do HOST: único runtime executável/validável neste
  ambiente, presente no Bazzite via binário local, e sem dependências npm.
- **SQLite nativo** (`node:sqlite`): armazenamento local confiável, sem serviço
  externo.
- **Isolamento por usuário dedicado**: identidade de segurança real, não só
  diretório. Descarte com validação canônica anti-traversal/symlink.
- **Licença GPL-3.0**: imposta pelos quatro projetos base; nosso código adota a
  mesma.

## 3. Evidências de validação

- `npm run check` → sintaxe de todos os módulos OK.
- `npm test` → **26/26 aprovados**.
- `npm start` + chamada real a `/api/health` e `/api/setup-required` → respostas
  corretas (`{"ok":true,...}`, `{"required":true}`).

## 4. Limitações conhecidas (não validadas aqui)

- **Streaming real, GPU, Bazzite, VFIO, Android, Tailscale:** não é possível
  executar neste ambiente (sem Bazzite, GPU de jogo, Android SDK nem rede
  dedicada). Procedimento de homologação em `ACCEPTANCE.md`.
- **Cliente nativo embutido (moonlight-common-c):** não incorporado nesta versão
  (GPL-3 exigiria publicar o código integral); usa-se o app Moonlight externo,
  documentado em `THIRD_PARTY.md`.
- **Windows (dev):** modo `temp-home` sem isolamento de SO — só para validar o
  plano de controle.

## 5. Arquivos criados/alterados

```
package.json                       # scripts (start/test/check), GPL-3
.gitignore                         # ignora data/, third_party/, segredos
README.md                          # visão geral
LICENSE                            # GPL-3.0
host/src/{config,db,auth,probe,sunshine,isolation,session,server,index}.js
host/public/{index.html,style.css,app.js,manifest.webmanifest,icon.svg}
deploy/bazzite/{install.sh,moonshine-host.service}
tests/{helpers,test-auth,test-isolation,test-session,test-server}.js
docs/{README,SECURITY,THIRD_PARTY,BAZZITE,ACCEPTANCE,REPORT}.md
third_party/{sunshine,moonlight-qt,moonlight-android,moonlight-common-c}  # clonados p/ referência (fora do Git)
```

## 6. Próximas etapas para o produto

1. Homologar no Bazzite real conforme `ACCEPTANCE.md`.
2. Validar isolamento (usuário dedicado, HOME 0700, biblioteca ro).
3. Parear Moonlight ↔ Sunshine e confirmar streaming de ponta a ponta.
4. Avaliar, num futuro release, incorporar moonlight-common-c para streaming
   embutido (com as obrigações GPL-3 correspondentes).
