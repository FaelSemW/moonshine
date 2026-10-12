#!/usr/bin/env bash
# Instalador do HOST Moonshine para Bazzite / Fedora Atomic (ostree).
#
# Princípios para a base imutável do Bazzite:
#  - NÃO usa dnf para instalar pacotes de sistema (a raiz é somente leitura).
#  - Sunshine é o Flatpak oficial (dev.lizardbyte.app.Sunshine) do Flathub.
#  - Node.js é obtido como binário oficial pré-compilado em ~/.local (não requer root).
#  - O serviço é uma user unit do systemd (~/.config/systemd/user), sem sudo.
#  - Tudo vive sob a home do usuário; nada é gravado fora do escopo.
#
# Uso (no Desktop Mode do Bazzite):
#   bash install.sh
set -euo pipefail

MOON_DIR="$HOME/moonshine"
LOCAL_BIN="$HOME/.local/bin"
NODE_VERSION="22.23.3"
FLATPAK_ID="dev.lizardbyte.app.Sunshine"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32mOK \033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!! \033[0m %s\n' "$*"; }

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) echo "Arquitetura não suportada: $ARCH"; exit 1 ;;
esac

info "Verificando Bazzite / Fedora Atomic"
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "Sistema: ${PRETTY_NAME:-desconhecido}"
fi

# ---------------------------------------------------------------- Node.js ----
install_node() {
  if command -v node >/dev/null 2>&1; then
    local v; v="$(node --version | tr -d v)"
    ok "Node.js já instalado ($v)"
    return
  fi
  info "Baixando Node.js $NODE_VERSION (binário oficial, sem root)"
  mkdir -p "$LOCAL_BIN"
  local url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/node.tar.xz"
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  cp "$tmp/node-v$NODE_VERSION-linux-$NODE_ARCH/bin/node" "$LOCAL_BIN/node"
  chmod +x "$LOCAL_BIN/node"
  rm -rf "$tmp"
  ok "Node.js instalado em $LOCAL_BIN/node"
}

# ------------------------------------------------------------- Sunshine -----
install_sunshine() {
  info "Garantindo o Sunshine (Flatpak oficial do Flathub)"
  if ! command -v flatpak >/dev/null 2>&1; then
    warn "flatpak não encontrado. Instale via Discover (Flatpak) e rode de novo."
    return 1
  fi
  if ! flatpak info "$FLATPAK_ID" >/dev/null 2>&1; then
    info "Adicionando Flathub (se necessário) e instalando Sunshine"
    flatpak --user remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo || true
    flatpak --user install -y flathub "$FLATPAK_ID" || {
      warn "Falha ao instalar o Sunshine via Flatpak. Instale pelo Discover e rode de novo."
      return 1
    }
  fi
  ok "Sunshine instalado ($FLATPAK_ID)"
  # Habilita o unit de serviço do Sunshine gerenciado pelo próprio Flatpak.
  if [ -f "$HOME/.config/systemd/user/$FLATPAK_ID.service" ]; then
    systemctl --user enable --now "$FLATPAK_ID.service" 2>/dev/null || true
  fi
}

# --------------------------------------------------------- Código Moonshine --
install_code() {
  info "Instalando o serviço Moonshine em $MOON_DIR"
  mkdir -p "$MOON_DIR"
  # Se o código já foi extraído/clonado para esta pasta, mantém. Caso contrário,
  # espera que o usuário tenha copiado o diretório do projeto para cá.
  if [ ! -f "$MOON_DIR/host/src/index.js" ]; then
    warn "Código não encontrado em $MOON_DIR."
    warn "Copie o conteúdo do projeto (pasta host/, client/, deploy/) para $MOON_DIR e rode de novo."
    return 1
  fi
  ok "Código presente em $MOON_DIR"
}

# ------------------------------------------------------------- Serviço ------
install_service() {
  info "Instalando user unit do systemd"
  mkdir -p "$HOME/.config/systemd/user"
  local unit="$HOME/.config/systemd/user/moonshine-host.service"
  sed -e "s|%h/moonshine|$MOON_DIR|g" \
      "$MOON_DIR/deploy/bazzite/moonshine-host.service" > "$unit"
  # Ajusta o caminho do node para o binário local.
  if [ -x "$LOCAL_BIN/node" ]; then
    sed -i "s|/usr/bin/node|$LOCAL_BIN/node|g" "$unit"
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now moonshine-host.service
  ok "Serviço moonshine-host habilitado e iniciado"
}

# -------------------------------------------------------------- Tailscale ----
info_tailscale() {
  info "Rede privada (recomendado)"
  echo "  O Moonshine expõe o painel em loopback por padrão. Para acessar de fora,"
  echo "  instale o Tailscale (Flatpak ou binário) e use o Tailscale Serve:"
  echo "    flatpak install -y flathub com.tailscale.tailscale"
  echo "  Depois, no painel, aponte o cliente para o endereço Tailscale do HOST."
  echo "  NÃO exponha o painel direto à internet pública."
}

main() {
  install_node
  install_sunshine
  install_code || true
  install_service || warn "Serviço não instalado (verifique os avisos acima)."
  info_tailscale
  echo
  ok "Concluído. Abra o painel em: http://127.0.0.1:47990"
  echo "  Na primeira vez, crie o administrador pela interface."
}

main "$@"
