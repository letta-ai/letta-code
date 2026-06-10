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

Known preference keys:

- `defaultWorkingDirectory`: default folder for new local sessions.
- `theme`: `auto`, `light`, or `dark`.
- `allowRemoteAccess`: boolean for whether remote access should be enabled in preferences.
- `remoteEnvName`: environment name shown for remote access.

## Workflow

1. Read the existing JSON first.
2. Preserve unknown keys.
3. Merge only the requested preference updates.
4. Write pretty JSON with a trailing newline.
5. Do not edit token, provider, secret, agent, conversation, memory, or unrelated state files.
6. Tell the user that the change applies live only if their Desktop build watches preference-file changes; otherwise they should reload/restart Desktop or use Preferences → General.

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
