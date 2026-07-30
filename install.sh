#!/usr/bin/env bash

set -euo pipefail

PACKAGE_NAME="@letta-ai/letta-code"
NODE_MAJOR=22
NODE_MIN_MINOR=19
INSTALL_ROOT="${LETTA_INSTALL_ROOT:-$HOME/.local/share/letta}"
BIN_DIR="${LETTA_BIN_DIR:-$HOME/.local/bin}"
VERSION="${LETTA_VERSION:-latest}"
NPM_SPEC="${LETTA_NPM_SPEC:-}"
MODIFY_PATH=true

info() {
  printf '==> %s\n' "$1"
}

warn() {
  printf 'Warning: %s\n' "$1" >&2
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Letta Code installer

Usage: install.sh [options]

Options:
  --version VERSION   Install a specific Letta Code version (default: latest)
  --no-modify-path    Do not update shell profile files
  -h, --help          Show this help

Environment overrides:
  LETTA_INSTALL_ROOT  Runtime and package directory
  LETTA_BIN_DIR       Directory for the letta launcher
  LETTA_VERSION       Version to install
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --no-modify-path)
      MODIFY_PATH=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

if [ -z "$NPM_SPEC" ] && ! [[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
  die "invalid version: $VERSION"
fi

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  die "run this installer without sudo; Letta Code installs into your home directory"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

case "$(uname -s)" in
  Darwin)
    OS="darwin"
    ;;
  Linux)
    OS="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    die "use install.ps1 for native Windows"
    ;;
  *)
    die "unsupported operating system: $(uname -s)"
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    die "unsupported architecture: $(uname -m)"
    ;;
esac

if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    ARCH="arm64"
  fi
fi

NODE_DIR="$INSTALL_ROOT/node"
NPM_PREFIX="$INSTALL_ROOT/npm"
PACKAGE_ENTRY="$NPM_PREFIX/lib/node_modules/$PACKAGE_NAME/letta.js"
PACKAGE_SHIM="$NPM_PREFIX/bin/letta"
LAUNCHER="$BIN_DIR/letta"

node_is_compatible() {
  local node_bin="$1"
  local version major minor

  [ -x "$node_bin" ] || return 1
  version="$($node_bin --version 2>/dev/null || true)"
  version="${version#v}"
  major="${version%%.*}"
  version="${version#*.}"
  minor="${version%%.*}"

  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [[ "$minor" =~ ^[0-9]+$ ]] || return 1

  [ "$major" -gt "$NODE_MAJOR" ] || {
    [ "$major" -eq "$NODE_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]
  }
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | awk '{print $NF}'
  else
    die "sha256sum, shasum, or openssl is required to verify Node.js"
  fi
}

install_managed_node() {
  local platform="${OS}-${ARCH}"
  local base_url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  local temp_dir archive expected actual extracted staged

  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' RETURN

  info "Downloading Node.js ${NODE_MAJOR} for ${platform}"
  curl -fsSL "$base_url/SHASUMS256.txt" -o "$temp_dir/SHASUMS256.txt"
  archive="$(awk -v pattern="^node-v${NODE_MAJOR}\\.[0-9]+\\.[0-9]+-${platform}\\.tar\\.gz$" '$2 ~ pattern { print $2; exit }' "$temp_dir/SHASUMS256.txt")"
  [ -n "$archive" ] || die "no Node.js archive is available for ${platform}"

  expected="$(awk -v archive="$archive" '$2 == archive { print $1; exit }' "$temp_dir/SHASUMS256.txt")"
  [ -n "$expected" ] || die "Node.js checksum is missing for $archive"

  curl -fsSL "$base_url/$archive" -o "$temp_dir/$archive"
  actual="$(sha256_file "$temp_dir/$archive")"
  [ "$actual" = "$expected" ] || die "Node.js checksum verification failed"

  mkdir -p "$temp_dir/extract"
  tar -xzf "$temp_dir/$archive" -C "$temp_dir/extract"
  extracted="$temp_dir/extract/${archive%.tar.gz}"
  [ -x "$extracted/bin/node" ] || die "downloaded Node.js archive is incomplete"

  mkdir -p "$INSTALL_ROOT"
  staged="$INSTALL_ROOT/.node-new-$$"
  rm -rf "$staged"
  mv "$extracted" "$staged"
  rm -rf "$NODE_DIR"
  mv "$staged" "$NODE_DIR"

  trap - RETURN
  rm -rf "$temp_dir"
}

NODE_BIN=""
NPM_CMD=""

if node_is_compatible "$NODE_DIR/bin/node" && [ -x "$NODE_DIR/bin/npm" ]; then
  NODE_BIN="$NODE_DIR/bin/node"
  NPM_CMD="$NODE_DIR/bin/npm"
  info "Using managed $($NODE_BIN --version)"
elif command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node_is_compatible "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
  NPM_CMD="$(command -v npm)"
  info "Using $($NODE_BIN --version) from PATH"
else
  install_managed_node
  NODE_BIN="$NODE_DIR/bin/node"
  NPM_CMD="$NODE_DIR/bin/npm"
  info "Installed $($NODE_BIN --version)"
fi

NODE_BIN_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_BIN_DIR:$PATH"
export NPM_CONFIG_UPDATE_NOTIFIER=false

mkdir -p "$NPM_PREFIX" "$BIN_DIR"

if [ -n "$NPM_SPEC" ]; then
  INSTALL_TARGET="$NPM_SPEC"
else
  INSTALL_TARGET="$PACKAGE_NAME@$VERSION"
fi

info "Installing Letta Code ($INSTALL_TARGET)"
"$NPM_CMD" install --global --prefix "$NPM_PREFIX" --no-audit --no-fund --loglevel=error "$INSTALL_TARGET"

[ -f "$PACKAGE_ENTRY" ] || die "npm did not install the Letta Code entrypoint"
[ -x "$PACKAGE_SHIM" ] || die "npm did not create the Letta Code command"

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

node_dir_quoted="$(shell_quote "$NODE_BIN_DIR")"
npm_prefix_quoted="$(shell_quote "$NPM_PREFIX")"
package_shim_quoted="$(shell_quote "$PACKAGE_SHIM")"
launcher_temp="$BIN_DIR/.letta-new-$$"

cat > "$launcher_temp" <<EOF
#!/bin/sh
set -e
NODE_BIN_DIR=$node_dir_quoted
NPM_PREFIX=$npm_prefix_quoted
PACKAGE_SHIM=$package_shim_quoted
export PATH="\$NODE_BIN_DIR:\$PATH"
export LETTA_UPDATE_INSTALL_PREFIX="\$NPM_PREFIX"
export NPM_CONFIG_UPDATE_NOTIFIER=false
export LETTA_PACKAGE_MANAGER=npm
exec "\$PACKAGE_SHIM" "\$@"
EOF
chmod 755 "$launcher_temp"
mv -f "$launcher_temp" "$LAUNCHER"

path_contains() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

add_to_path() {
  local shell_name profile line quoted_bin_dir
  shell_name="$(basename "${SHELL:-sh}")"
  quoted_bin_dir="$(shell_quote "$BIN_DIR")"

  case "$shell_name" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) profile="$HOME/.bashrc" ;;
    fish) profile="$HOME/.config/fish/config.fish" ;;
    *) profile="$HOME/.profile" ;;
  esac

  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  if [ "$shell_name" = "fish" ]; then
    line="fish_add_path $quoted_bin_dir"
  else
    line="export PATH=$quoted_bin_dir:\"\$PATH\""
  fi

  if ! grep -F "$line" "$profile" >/dev/null 2>&1; then
    {
      printf '\n# Letta Code\n'
      printf '%s\n' "$line"
    } >> "$profile"
    info "Added $BIN_DIR to PATH in $profile"
  fi
}

PATH_READY=false
if path_contains "$BIN_DIR" && [ "$(command -v letta 2>/dev/null || true)" = "$LAUNCHER" ]; then
  PATH_READY=true
fi

if [ "$PATH_READY" = false ]; then
  if [ "$MODIFY_PATH" = true ]; then
    add_to_path
  else
    warn "$LAUNCHER is not the active letta command on PATH"
  fi
fi

installed_version="$("$LAUNCHER" --version 2>/dev/null || true)"
[ -n "$installed_version" ] || die "Letta Code was installed but failed its version check"

printf '\nLetta Code %s installed successfully.\n' "$installed_version"
if [ "$PATH_READY" = false ]; then
  printf 'Open a new terminal, or run: export PATH="%s:$PATH"\n' "$BIN_DIR"
fi
printf 'Run: letta\n'
