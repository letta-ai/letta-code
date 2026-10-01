---
name: editing-letta-code-desktop-preferences
description: Edits Letta Code Desktop (LCD) preferences by safely reading and updating ~/.letta/desktop_preferences.json. Use only when the user asks to change current Desktop/LCD settings such as theme, default working directory, remote access preference, or remote environment name via the preferences JSON.
---

# Editing Letta Code Desktop Preferences

Use this skill only to edit the active Letta Code Desktop preferences JSON file. Do not use it for Desktop product-code changes, Electron IPC work, UI changes, or general Letta Cloud Desktop implementation tasks.

## Preferences file

The Desktop preferences file is:

```text
~/.letta/desktop_preferences.json
```

User-editable preference keys:

- `defaultWorkingDirectory`: default folder for new local sessions.
- `theme`: `auto`, `light`, or `dark`.
- `allowRemoteAccess`: boolean for whether remote access should be enabled in preferences.
- `runInBackground`: boolean for whether Desktop stays alive in tray/menu bar when all windows close.
- `startAtLogin`: boolean for whether Desktop starts hidden at login.
- `remoteEnvName`: environment name shown in the Letta Cloud environment picker for the cloud listener.
- `localBackendDirectory`: directory containing local backend agents, conversations, and memory.
- `allowLocalAgentsWhenSignedIn`: boolean for whether signed-in Desktop sessions can see local/offline agents.

System-managed keys (do not edit directly):
- `artifactsByAgent`: per-agent artifacts panel state, written by Desktop UI.
- `debugPanelEnabled`: developer debug panel, controlled via app menus.
- `remoteAppServerEnabled`: Remote App Server toggle, applied at startup.
- `remoteAppServerUrl`: Remote App Server URL, configured via preferences UI.

## Workflow

1. Read the existing JSON first.
2. Preserve unknown keys.
3. Merge only the requested preference updates.
4. Write pretty JSON with a trailing newline.
5. Do not edit token, provider, secret, agent, conversation, memory, or unrelated state files.
6. Changes apply live within ~100ms via Desktop's file watcher; if Desktop is not running, changes take effect on next startup.

## Safe edit command

Use a merge-style edit like this, changing only the requested keys:

```bash
node - <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(os.homedir(), '.letta', 'desktop_preferences.json');
fs.mkdirSync(path.dirname(file), { recursive: true });

const current = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : {};

const next = {
  ...current,
  // Example update. Replace this with the user's requested setting.
  theme: 'dark',
};

fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
NODE
```

## Validation

After editing, read the file back or parse it to confirm valid JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.letta/desktop_preferences.json', 'utf8')); console.log('desktop_preferences.json is valid')"
```
