#!/usr/bin/env bash
set -euo pipefail

# Pin the same Bun version as package.json "packageManager".
export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "1.3.10" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.10"
fi

if [ -x "${BUN_INSTALL}/bin/bun" ]; then
  sudo ln -sfn "${BUN_INSTALL}/bin/bun" /usr/local/bin/bun
fi
if [ -e "${BUN_INSTALL}/bin/bunx" ]; then
  sudo ln -sfn "${BUN_INSTALL}/bin/bunx" /usr/local/bin/bunx
fi

bun install --frozen-lockfile
