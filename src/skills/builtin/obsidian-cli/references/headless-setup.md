# Headless Obsidian CLI Setup

## Critical: Use deb package, NOT snap

Snap confinement creates separate filesystem namespaces. The CLI process and the running Obsidian instance end up with different `SingletonLock`/`SingletonSocket` paths, so CLI can't connect via IPC. The deb package avoids this entirely.

```bash
# Remove snap if installed
sudo snap remove obsidian

# Install deb
wget https://github.com/obsidianmd/obsidian-releases/releases/download/v1.11.7/obsidian_1.11.7_amd64.deb
sudo dpkg -i obsidian_1.11.7_amd64.deb
```

## Enable CLI via Config

CLI requires `insider` (early access) and `cli` flags in the global config. Enable from a local machine with UI access, then copy to the server.

### Config locations
- **Linux**: `~/.config/obsidian/obsidian.json`
- **macOS**: `~/Library/Application Support/obsidian/obsidian.json`

### Required entries
```json
{
  "vaults": { ... },
  "insider": true,
  "cli": true
}
```

The `insider` flag enables early access features. The `cli` flag enables the CLI. Both are set when you toggle CLI on in Settings > General on a machine with UI access.

## Running Headless

### Prerequisites
```bash
sudo apt install xvfb
```

### Start xvfb (if not already running)
```bash
Xvfb :5 -extension GLX -screen 0 800x600x16 &
```

### Start Obsidian
```bash
DISPLAY=:5 nohup obsidian --no-sandbox --disable-gpu --disable-software-rasterizer --in-process-gpu > /tmp/obsidian.log 2>&1 &
```

The `--disable-gpu` and related flags prevent GPU initialization crashes on headless servers. GPU errors in stderr are harmless and can be ignored.

### Auto-update
On first launch with `insider: true`, Obsidian will download the latest insider .asar to `~/.config/obsidian/obsidian-<version>.asar` and load it on subsequent starts.

## Using CLI

```bash
DISPLAY=:5 obsidian daily:read
DISPLAY=:5 obsidian search query="meeting notes" limit=5
```

The `DISPLAY` variable is needed because the CLI process briefly initializes Electron (even for IPC). Filter stderr noise:

```bash
DISPLAY=:5 obsidian daily:read 2>/dev/null
```

## Verification

```bash
DISPLAY=:5 obsidian version          # Should print version
DISPLAY=:5 obsidian vault            # Should show vault info
DISPLAY=:5 obsidian daily:read       # Should print daily note
```
