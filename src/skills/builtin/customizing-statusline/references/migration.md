# Statusline Migration

Use this reference when migrating legacy command statuslines, standalone `.sh` statusline scripts, or shell PS1 prompts into `~/.letta/mods/statusline.tsx`.

## Legacy Letta command statusline

Inspect these files for old config:

```text
~/.letta/settings.json
<project>/.letta/settings.json
<project>/.letta/settings.local.json
```

Look for either shape:

```json
{
  "statusLine": {
    "type": "command",
    "command": "..."
  }
}
```

```json
{
  "statusLine": {
    "command": "...",
    "refreshIntervalMs": 30000,
    "timeout": 5000,
    "debounceMs": 300,
    "padding": 0,
    "prompt": ">"
  }
}
```

When migrating:

- Preserve old config and referenced files unless the user explicitly asks to delete them.
- If `command` references a `.sh` file, read it before writing the new mod.
- Translate polling (`refreshIntervalMs`) to `setInterval` + `panel.update()`.
- Translate direct command output into a cached closure variable plus synchronous rendering.
- If the command output used `\x1e` to split left/right output, convert it to `row(left, right, width)`; there is no separate left/right API.
- Treat old prompt customization separately. The statusline controls the primary row, not necessarily the input prompt.

Old model:

```sh
echo "$(git branch --show-current)"
```

New model:

```tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.ui.panels) return;

  let branch = "";

  const panel = letta.ui.openPanel({
    id: "statusline",
    order: 0,
    render: ({ width, row }) => row(branch, "", width),
  });

  const update = async () => {
    try {
      const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: process.cwd(),
      });
      branch = stdout.trim();
    } catch {
      branch = "";
    }
    panel.update();
  };

  void update();
  const timer = setInterval(update, 30_000);
  return () => {
    clearInterval(timer);
    panel.close();
  };
}
```

## Standalone `.sh` file migration

If the user provides a `.sh` path:

1. Read the script.
2. Identify commands, expected stdin JSON, environment variables, and output shape.
3. Port shell commands to async setup/update code.
4. Store results in closure variables.
5. Render cached state synchronously and call `panel.update()` after each refresh.
6. Preserve graceful fallbacks for missing tools, not-a-git-repo, no PR, etc. (return `""` to hide the line).

Map the script's stdin JSON to the render context's semantic fields (`agent`, `model`, `width`); compute anything else in setup/update code.

## Shell PS1 import

If the user asks to match their shell prompt, inspect shell config files in this order:

```text
~/.zshrc
~/.bashrc
~/.bash_profile
~/.profile
```

Extract PS1 with:

```js
/(?:^|\n)\s*(?:export\s+)?PS1\s*=\s*["']([^"']+)["']/m
```

Map common escapes:

```text
\u -> username
\h -> short hostname
\H -> hostname
\w -> current working directory
\W -> basename(current working directory)
\$ -> prompt character, usually remove if trailing
\n -> newline
\t -> HH:MM:SS
\d -> date like Tue May 23
\@ -> 12-hour time
\# -> command number, usually omit unless requested
\! -> history number, usually omit unless requested
```

If the imported prompt ends with `$`, `>`, or similar prompt chars, remove that trailing prompt marker. The statusline is not the input prompt.

If no PS1 is found and the user did not provide other instructions, ask for one of:

1. the output of `echo $PS1`
2. a description of what their prompt shows
3. the current prompt output as it appears in their terminal

Preserve colors where practical with `chalk`. If the PS1 is too dynamic to port exactly, ask whether to approximate it or port specific commands.
