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
- `npm test` → **28/28 aprovados**.
- CI GitHub Actions → verde (build + boot do HOST + shellcheck do instalador).

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
- [x] 26 testes automatizados passando (`npm test`).

Procedimento para reproduzir: `npm test` e `npm start` nesta máquina.

## Pendente — HOST no Bazzite real

- [ ] Instalação via `deploy/bazzite/install.sh` num Bazzite com GPU.
      Procedimento: rodar no Desktop Mode, abrir `127.0.0.1:47990`, criar admin.
- [ ] Sunshine Flatpak instalado, com permissão de GPU e codificação ativa.
      Procedimento: painel do Sunshine → verificar VA-API/NVENC; conferir se
      `/serverinfo` (47989) responde.
- [ ] Criação real de usuário Linux dedicado (`useradd`) e descarte (`userdel`).
      Procedimento: iniciar sessão como jogador, conferir `id msplayer-*` e que
      o HOME temporário é descartado ao final.
- [ ] Isolamento real: jogador não lê arquivos do proprietário.
      Procedimento: dentro da sessão, tentar `ls ~proprietário` e confirmar erro
      de permissão; conferir permissões 0700 do HOME temporário.
- [ ] Biblioteca de jogos somente-leitura de verdade.
      Procedimento: tentar gravar no diretório da biblioteca dentro da sessão.
- [ ] Autostart do serviço via systemd --user após reboot.

## Pendente — Streaming real

- [ ] Moonlight (Android ou desktop) pareado com o Sunshine do HOST.
      Procedimento: Moonlight → adicionar host → PIN → confirmar pareamento.
- [ ] Streaming real de vídeo/áudio/controles iniciado após a reserva no Moonshine.
      Procedimento: reservar pelo Moonshine, abrir Moonlight, lançar, jogar.
- [ ] Fim de sessão detectado quando o jogador sai do Moonlight → limpeza.

## Pendente — Cliente

- [ ] Android: app/PWA instalado, autentica e reserva; deep-link `moonlight://`
      abre o Moonlight real.
- [ ] Windows/Linux: navegador/PWA autentica e reserva; Moonlight-Qt pareado.

## Como cada pendência será confirmada

Cada item acima tem um procedimento objetivo. Onde falhar, registre o log do
serviço (`/api/admin/events`), o estado da máquina e o output de
`journalctl --user -u moonshine-host`. Nada aqui é afirmado como concluído sem
evidência nesse hardware.
