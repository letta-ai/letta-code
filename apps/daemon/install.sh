#!/bin/sh
set -eu

RELEASE_BASE="${LETTA_DAEMON_RELEASE_BASE:-https://github.com/letta-ai/letta-code/releases/latest/download}"
SYSTEM=$(uname -s)
MACHINE=$(uname -m)

case "$MACHINE" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) echo "Letta Daemon does not support architecture: $MACHINE" >&2; exit 1 ;;
esac

case "$SYSTEM" in
  Darwin) ASSET="letta-daemon-mac-$ARCH.zip" ;;
  Linux)
    if [ "$ARCH" = "x64" ]; then ARCH=x86_64; fi
    ASSET="letta-daemon-linux-$ARCH.AppImage"
    ;;
  *) echo "Use install.ps1 to install Letta Daemon on Windows." >&2; exit 1 ;;
esac

TMPDIR_PATH=$(mktemp -d "${TMPDIR:-/tmp}/letta-daemon.XXXXXX")
trap 'rm -rf "$TMPDIR_PATH"' EXIT INT TERM

echo "Downloading $ASSET..."
curl -fsSL "$RELEASE_BASE/$ASSET" -o "$TMPDIR_PATH/$ASSET"
curl -fsSL "$RELEASE_BASE/SHA256SUMS" -o "$TMPDIR_PATH/SHA256SUMS"

EXPECTED=$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TMPDIR_PATH/SHA256SUMS")
if [ -z "$EXPECTED" ]; then
  echo "The release does not contain a checksum for $ASSET." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMPDIR_PATH/$ASSET" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "$TMPDIR_PATH/$ASSET" | awk '{print $1}')
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum verification failed for $ASSET." >&2
  exit 1
fi

if [ "$SYSTEM" = "Darwin" ]; then
  DESTINATION="$HOME/Applications"
  mkdir -p "$DESTINATION"
  ditto -x -k "$TMPDIR_PATH/$ASSET" "$TMPDIR_PATH/unpacked"
  if [ ! -d "$TMPDIR_PATH/unpacked/Letta Daemon.app" ]; then
    echo "The macOS archive did not contain Letta Daemon.app." >&2
    exit 1
  fi
  codesign --verify --deep --strict --verbose=2 "$TMPDIR_PATH/unpacked/Letta Daemon.app"
  codesign -dv --verbose=4 "$TMPDIR_PATH/unpacked/Letta Daemon.app" 2>&1 \
    | grep -Eq '^Authority=Developer ID Application: .*Letta'
  spctl --assess --type execute --verbose=2 "$TMPDIR_PATH/unpacked/Letta Daemon.app"

  STAGED_APP="$DESTINATION/.letta-daemon.new.$$"
  BACKUP_APP="$DESTINATION/.letta-daemon.backup.$$"
  trap '
    if [ ! -d "$DESTINATION/Letta Daemon.app" ] && [ -d "$BACKUP_APP" ]; then
      mv "$BACKUP_APP" "$DESTINATION/Letta Daemon.app"
    fi
    rm -rf "$STAGED_APP" "$TMPDIR_PATH"
  ' EXIT INT TERM
  rm -rf "$STAGED_APP" "$BACKUP_APP"
  ditto "$TMPDIR_PATH/unpacked/Letta Daemon.app" "$STAGED_APP"
  if [ -d "$DESTINATION/Letta Daemon.app" ]; then
    mv "$DESTINATION/Letta Daemon.app" "$BACKUP_APP"
  fi
  if mv "$STAGED_APP" "$DESTINATION/Letta Daemon.app"; then
    rm -rf "$BACKUP_APP"
  else
    if [ -d "$BACKUP_APP" ]; then
      mv "$BACKUP_APP" "$DESTINATION/Letta Daemon.app"
    fi
    echo "Could not replace the existing Letta Daemon installation." >&2
    exit 1
  fi
  open "$DESTINATION/Letta Daemon.app"
  echo "Installed Letta Daemon in $DESTINATION."
  exit 0
fi

BIN_DIR="$HOME/.local/bin"
APPLICATIONS_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APPLICATIONS_DIR"
install -m 0755 "$TMPDIR_PATH/$ASSET" "$BIN_DIR/letta-daemon"
cat > "$APPLICATIONS_DIR/com.letta.daemon.desktop" <<EOF
[Desktop Entry]
Name=Letta Daemon
Comment=Keep this computer available to Letta agents
Exec="$BIN_DIR/letta-daemon"
Terminal=false
Type=Application
Categories=Development;
EOF
nohup "$BIN_DIR/letta-daemon" >/dev/null 2>&1 &
echo "Installed Letta Daemon at $BIN_DIR/letta-daemon."
