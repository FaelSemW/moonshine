# Moonshine Cloud Gaming

[![CI](https://github.com/FaelSemW/moonshine/actions/workflows/ci.yml/badge.svg)](https://github.com/FaelSemW/moonshine/actions/workflows/ci.yml)

Plataforma própria de cloud gaming: um PC gamer no Bazzite fica disponível para
um jogador por vez, que joga remotamente e tem seu ambiente temporário removido
com segurança ao final da sessão.

Construída sobre os projetos open source comprovados **Sunshine** (servidor de
streaming) e **Moonlight** (clientes), ambos GPL-3.0. Nenhum deles é reescrito.

- **HOST:** serviço Node.js (sem dependências externas) + SQLite. Autenticação,
  reserva exclusiva, isolamento de sessão, gestão do Sunshine e painel
  administrativo integrado. Escuta em loopback; exposto na rede privada via
  Tailscale Serve.
- **CLIENTE:** interface web/PWA (Android e desktop) que autentica, mostra o
  estado em tempo real, reserva a sessão e então delega o **streaming real** ao
  Moonlight, que conecta direto no Sunshine.

> **Honestidade técnica:** o vídeo, áudio e controles são transmitidos pelo
> Moonlight (app oficial), não embutidos nesta versão. O Moonshine é o **plano
> de controle**: autoriza, reserva, prepara, monitora e limpa. Ver
> [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md) e [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Executar o HOST (desenvolvimento)

Requer Node.js 22.5+ (testado com 22.23.3). Sem dependências npm externas.

```sh
npm start        # sobe em http://127.0.0.1:47990
npm test         # 26 testes automatizados
npm run check    # verificação de sintaxe
```

Abra `http://127.0.0.1:47990`, crie o administrador na primeira tela e use o
painel. Em Windows/macOS o HOST opera em modo de desenvolvimento (isolamento de
SO desativado); ele **não** finge streaming.

### CLI de diagnóstico e configuração

```sh
npm run doctor          # verifica SO, GPU, Sunshine, pareamento e estado
npm run setup-sunshine  # configura credenciais do Sunshine + app "Desktop"
node host/src/cli.js create-user jogador1 senha123   # cria um jogador
node host/src/cli.js state                          # estado da máquina
node host/src/cli.js unlock                         # libera máquina travada
```

## Implantação no Bazzite

Siga [docs/BAZZITE.md](docs/BAZZITE.md). **Um comando** no Desktop Mode do Bazzite (sem sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/FaelSemW/moonshine/main/deploy/bazzite/install.sh | bash
```

Instala Node.js local (sem root), garante o Sunshine via Flatpak oficial, clona o código para `~/moonshine` e registra uma user unit do systemd. Nada altera a raiz imutável.

## Arquitetura

```
Cliente (web/PWA)  ──HTTP/Tailscale──►  HOST Moonshine (Node+SQLite)
   │  autentica, reserva, estado            │ valida, reserva, prepara,
   │                                        │ monitora, limpa
   └──moonlight://──► Moonlight ──GameStream──► Sunshine ──► GPU/jogo
```

- O **vídeo/áudio/entra­da** vai direto Moonlight ↔ Sunshine (baixa latência).
- O **controle** (quem pode jogar, quando, e limpeza) é do Moonshine.

## Isolamento de sessão

Cada sessão usa um **usuário Linux dedicado** com `HOME` temporário descartável;
a biblioteca de jogos é **somente leitura**; se a limpeza falhar, a máquina fica
**bloqueada** até recuperação administrativa. Detalhes e limites em
[docs/SECURITY.md](docs/SECURITY.md).

## Documentação

- [docs/BAZZITE.md](docs/BAZZITE.md) — instalação, configuração e recuperação
- [docs/SECURITY.md](docs/SECURITY.md) — modelo de segurança e isolamento
- [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md) — licenças e obrigações
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — roteiro de homologação em hardware
- [docs/REPORT.md](docs/REPORT.md) — o que foi implementado e validado

## Licença

GPL-3.0-only. Ver [LICENSE](LICENSE).
