#!/usr/bin/env bash
# Moonshine — helper privilegiado do isolamento de sessões (usuário dedicado).
#
# O HOST roda como user unit do systemd (systemd --user) e portanto SEM root.
# O modo de jogo isolado precisa de cinco operações com privilégio:
# criar/remover o usuário da sessão, dar e devolver a propriedade do diretório
# temporário e encerrar processos da sessão. Essas operações passam por ESTE
# script, autorizado no /etc/sudoers.d/moonshine-isolation com NOPASSWD
# restrito a ele (instalado pelo install.sh — único pedido de sudo dele).
#
# SEGURANÇA (este arquivo é o portão para root):
#  - Todo argumento é validado por regex estrita ANTES de qualquer comando.
#  - Os flags dos comandos são FIXOS aqui; o chamador envia só identificadores.
#  - Nenhum caminho fora de /var/tmp/moonshine-sessions/s<id>-<hex8> é aceito.
#  - Operação desconhecida, nome fora do padrão ou caminho fora do escopo:
#    recusa com exit 64 (EX_USAGE) e nenhuma execução acontece.
#  - 'release' só funciona via sudo (precisa do SUDO_USER = o serviço).
#
# Recuperação manual de lixo (ex.: sessão que traveu a máquina):
#   sudo ~/moonshine/deploy/bazzite/moonshine-helper.sh release <dir>
#   rm -rf <dir>
set -euo pipefail

# Usuário da sessão: prefixo começando com letra + sufixo de 6 hex aleatórios
# gerado pelo HOST (ex.: msplayer-1a2b3c). Máximo de 32 caracteres no total.
USER_RE='^[a-z][a-z0-9_-]{0,24}-[0-9a-f]{6}$'
# Diretório de sessão: um nível sob o root de sessões, id numérico + 8 hex.
# (Espelha o padrão de createSessionEnvironment: s<sessionId>-<random 4 bytes>.)
DIR_RE='^/var/tmp/moonshine-sessions/s[0-9]+-[0-9a-f]{8}$'
# HOME temporário da sessão: o diretório "home" dentro do diretório de sessão
# (é o que o HOST passa como --home-dir; nada é criado em /home).
HOME_RE='^/var/tmp/moonshine-sessions/s[0-9]+-[0-9a-f]{8}/home$'

die() { echo "moonshine-helper: $*" >&2; exit 64; }

[ "$#" -ge 1 ] || die "uso: add <usuario> <home> | del|kill <usuario> | chown <usuario> <dir> | release <dir>"
op="$1"
shift

case "$op" in
  add)
    [ "$#" -eq 2 ] || die "add: espera <usuario> <home-temporario>"
    name="$1"
    home="$2"
    [[ "$name" =~ $USER_RE ]] || die "nome de usuário fora do padrão: $name"
    [[ "$home" =~ $HOME_RE ]] || die "HOME fora do escopo: $home"
    if id -u "$name" >/dev/null 2>&1; then
      exit 0   # já existe — idempotente
    fi
    command -v useradd >/dev/null 2>&1 || die "useradd ausente neste sistema"
    exec "$(command -v useradd)" \
      --create-home \
      --home-dir "$home" \
      --shell /usr/sbin/nologin \
      --groups games \
      "$name"
    ;;

  del)
    [ "$#" -eq 1 ] || die "del: espera exatamente <usuario>"
    name="$1"
    [[ "$name" =~ $USER_RE ]] || die "nome de usuário fora do padrão: $name"
    command -v userdel >/dev/null 2>&1 || die "userdel ausente neste sistema"
    userdel="$(command -v userdel)"
    # Primeiro tenta remover também o HOME; se ele já foi descartado, remove
    # só o usuário. As duas falharem => exit com o erro (limpeza incompleta).
    "$userdel" --remove "$name" 2>/dev/null || "$userdel" "$name"
    ;;

  chown)
    [ "$#" -eq 2 ] || die "chown: espera <usuario> <diretorio>"
    name="$1"
    dir="$2"
    [[ "$name" =~ $USER_RE ]] || die "nome de usuário fora do padrão: $name"
    [[ "$dir" =~ $DIR_RE ]] || die "diretório fora do escopo: $dir"
    command -v chown >/dev/null 2>&1 || die "chown ausente neste sistema"
    exec "$(command -v chown)" -R "$name:$name" "$dir"
    ;;

  release)
    [ "$#" -eq 1 ] || die "release: espera <diretorio>"
    dir="$1"
    [[ "$dir" =~ $DIR_RE ]] || die "diretório fora do escopo: $dir"
    if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = "root" ]; then
      die "release exige invocação via sudo (SUDO_USER ausente)"
    fi
    command -v chown >/dev/null 2>&1 || die "chown ausente neste sistema"
    exec "$(command -v chown)" -R "$SUDO_USER:$SUDO_USER" "$dir"
    ;;

  kill)
    [ "$#" -eq 1 ] || die "kill: espera exatamente <usuario>"
    name="$1"
    [[ "$name" =~ $USER_RE ]] || die "nome de usuário fora do padrão: $name"
    command -v pkill >/dev/null 2>&1 || die "pkill ausente neste sistema"
    # Sem processos é sucesso (pkill sai em 1) — a limpeza não pode falhar
    # por não haver o que encerrar.
    "$(command -v pkill)" -KILL -u "$name" 2>/dev/null || true
    ;;

  *)
    die "operação desconhecida: $op"
    ;;
esac
