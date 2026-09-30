# Letta Daemon

Letta Daemon is a minimal system-tray wrapper around `letta server`. It keeps a
computer available to agents through Letta Cloud's authenticated outbound
connection without exposing a public inbound port.

The tray intentionally does only a few things:

- set or change the environment name;
- show whether Letta Code is connected, working, or reconnecting;
- restart Letta Code and open its logs;
- download daemon releases that carry the matching Letta Code runtime.

## Install

macOS and Linux use the same command:

```sh
curl -fsSL https://raw.githubusercontent.com/letta-ai/letta-code/main/apps/daemon/install.sh | sh
```

Windows PowerShell uses the same `curl`-download flow with a PowerShell
installer:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/letta-ai/letta-code/main/apps/daemon/install.ps1 -o "$env:TEMP\letta-daemon-install.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\letta-daemon-install.ps1"
```

The installers detect the local platform, download the corresponding artifact
from the latest GitHub release, and verify it against that release's
`SHA256SUMS` before installation. Production releases must additionally be
signed with Letta's Apple and Windows signing identities.

## Development

From the repository root:

```sh
bun install
bun run daemon:check
bun run daemon:dev
```

`daemon:dev` first builds the local Letta Code bundle so the tray supervises
the exact source revision under development.

Build an unpacked app for local packaging smoke tests:

```sh
bun run --cwd apps/daemon package:dir
```
