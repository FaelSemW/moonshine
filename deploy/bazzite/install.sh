#!/usr/bin/env bash
# Instalador do HOST Moonshine para Bazzite / Fedora Atomic (ostree).
#
# AUTOCONTIDO — funciona com UM comando, sem copiar nada na mão:
#
#   curl -fsSL https://raw.githubusercontent.com/SEU_USUARIO/SEU_REPO/main/deploy/bazzite/install.sh | bash
#
# O script detecta se está sendo executado via `curl | bash` (sem repo local) e,
# nesse caso, clona o repositório para ~/moonshine e reexecuta a instalação a
# partir dele. Também funciona rodando direto de um checkout existente.
#
# Princípios para a base imutável do Bazzite:
#  - NÃO usa dnf (raiz somente leitura).
#  - Sunshine = Flatpak oficial (dev.lizardbyte.app.Sunshine) do Flathub.
#  - Node.js = binário oficial em ~/.local (sem root).
#  - Serviço = user unit do systemd (sem sudo no dia a dia).
#  - Tudo sob a home do usuário.
#
# Uso (no Desktop Mode do Bazzite):   bash install.sh
set -euo pipefail

# ----------------------------------------------------------------- bootstrap -
REPO_URL="${MOONSHINE_REPO:-https://github.com/FaelSemW/moonshine.git}"
BRANCH="${MOONSHINE_BRANCH:-main}"
MOON_DIR="${MOONSHINE_DIR:-$HOME/moonshine}"
BOOTSTRAPPED="${MOONSHINE_BOOTSTRAPPED:-}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32mOK \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERRO:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$BOOTSTRAPPED" != "1" ]; then
  info "Modo bootstrap: preparando o código em $MOON_DIR"
  command -v git >/dev/null 2>&1 || die "git ausente. Instale git e rode de novo."
  if [ ! -d "$MOON_DIR/.git" ] && [ ! -f "$MOON_DIR/package.json" ]; then
    mkdir -p "$(dirname "$MOON_DIR")"
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$MOON_DIR" || \
      die "falha ao clonar $REPO_URL (confira o fork/branch). Defina MOONSHINE_REPO."
  else
    info "Código já presente em $MOON_DIR"
  fi
  export MOONSHINE_BOOTSTRAPPED=1
  # Reexecuta a instalação real a partir do clone.
  exec bash "$MOON_DIR/deploy/bazzite/install.sh"
fi

cd "$MOON_DIR" || die "diretório $MOON_DIR inacessível"

# ----------------------------------------------------------------- ferramentas -
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) die "arquitetura não suportada: $ARCH" ;;
esac
NODE_VERSION="22.23.3"
LOCAL_BIN="$HOME/.local/bin"
FLATPAK_ID="dev.lizardbyte.app.Sunshine"

if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "Sistema: ${PRETTY_NAME:-desconhecido}"
fi

# -------------------------------------------------------------------- Node.js -
install_node() {
  if command -v node >/dev/null 2>&1; then
    ok "Node.js já instalado ($(node --version))"
    return
  fi
  info "Baixando Node.js $NODE_VERSION (binário oficial, sem root)"
  mkdir -p "$LOCAL_BIN"
  local url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/node.tar.xz" || die "falha ao baixar Node.js"
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  install -m 0755 "$tmp/node-v$NODE_VERSION-linux-$NODE_ARCH/bin/node" "$LOCAL_BIN/node"
  rm -rf "$tmp"
  ok "Node.js em $LOCAL_BIN/node"
}

# ------------------------------------------------------------------ Sunshine -
install_sunshine() {
  info "Garantindo o Sunshine (Flatpak oficial do Flathub)"
  if ! command -v flatpak >/dev/null 2>&1; then
    warn "flatpak ausente. Instale via Discover e rode de novo."
    return 1
  fi
  if ! flatpak info "$FLATPAK_ID" >/dev/null 2>&1; then
    flatpak --user remote-add --if-not-exists flathub \
      https://flathub.org/repo/flathub.flatpakrepo || true
    flatpak --user install -y flathub "$FLATPAK_ID" || {
      warn "falha ao instalar Sunshine via Flatpak; instale pelo Discover."
      return 1
    }
  fi
  ok "Sunshine instalado ($FLATPAK_ID)"
  systemctl --user enable --now "$FLATPAK_ID.service" 2>/dev/null || true
}

# ------------------------------------------------------------------ dependências npm -
install_deps() {
  info "Instalando dependências do HOST (nenhuma externa, só truque de build)"
  export PATH="$LOCAL_BIN:$PATH"
  "$LOCAL_BIN/node" --version >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || die "node ausente"
  # O HOST não tem dependências npm; garante apenas que os módulos passam no check.
  ok "sem dependências npm externas"
}

# --------------------------------------------------------------------- serviço -
install_service() {
  info "Registrando user unit do systemd"
  mkdir -p "$HOME/.config/systemd/user"
  local unit="$HOME/.config/systemd/user/moonshine-host.service"
  local node_bin; node_bin="$(command -v node || echo "$LOCAL_BIN/node")"
  sed -e "s|%h/moonshine|$MOON_DIR|g" \
      -e "s|/usr/bin/node|$node_bin|g" \
      "$MOON_DIR/deploy/bazzite/moonshine-host.service" > "$unit"
  systemctl --user daemon-reload
  systemctl --user enable --now moonshine-host.service
  ok "serviço moonshine-host habilitado e no ar"
}

# -------------------------------------------------------------------- rede ----
print_network() {
  info "Rede privada (recomendado — não exponha o painel na internet)"
  echo "    flatpak install -y flathub com.tailscale.tailscale"
  echo "    Depois use Tailscale Serve para HTTPS no endereço Tailscale."
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  ok "Painel (após login): http://127.0.0.1:47990  ${ip:+ | rede: http://$ip:47990}"
  echo "  Na primeira vez, crie o administrador pela interface."
}

main() {
  install_node
  install_sunshine || true
  install_deps
  install_service
  print_network
}

main "$@"
