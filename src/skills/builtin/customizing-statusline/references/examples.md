# Statusline Examples

Use these as patterns, not mandatory templates. Keep the final mod focused on the user's request.

## Agent and model

```tsx
export default function activate(letta) {
  if (!letta.capabilities.ui.customStatuslineRenderer) return;

  letta.ui.setStatuslineRenderer((context) => {
    const { Text } = context.components;
    return <Text>{context.agent.name ?? "Letta"} · {context.model.displayName ?? "no model"}</Text>;
  });
}
```

## Git branch with fallback

```tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.ui.customStatuslineRenderer) return;

  const update = async () => {
    try {
      const context = letta.getContext();
      const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: context.workspace.currentDir,
      });
      letta.ui.setStatus("branch", stdout.trim());
    } catch {
      letta.ui.clearStatus("branch");
    }
  };

  letta.ui.setStatuslineRenderer((context) => {
    const { Text } = context.components;
    const branch = context.statuses.branch;
    return <Text>{branch ? `git ${branch}` : context.agent.name}</Text>;
  });

  void update();
  const timer = setInterval(update, 30_000);
  return () => clearInterval(timer);
}
```

## Full row with internal right alignment

```tsx
export default function activate(letta) {
  if (!letta.capabilities.ui.customStatuslineRenderer) return;

  letta.ui.setStatuslineRenderer((context) => {
    const { Box, Text } = context.components;
    const model = context.model.displayName ?? "no model";

    return (
      <Box flexDirection="row">
        <Box flexGrow={1}>
          <Text dimColor>Press / for commands</Text>
        </Box>
        <Text>{context.agent.name ?? "Letta"} · {model}</Text>
      </Box>
    );
  });
}
```

## GitHub PR number via `gh`

```tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.ui.customStatuslineRenderer) return;

  const update = async () => {
    try {
      const context = letta.getContext();
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", "--json", "number,title", "--jq", "\"#\\(.number) \\(.title)\""],
        { cwd: context.workspace.currentDir },
      );
      const pr = stdout.trim();
      pr ? letta.ui.setStatus("pr", pr) : letta.ui.clearStatus("pr");
    } catch {
      letta.ui.clearStatus("pr");
    }
  };

  letta.ui.setStatuslineRenderer((context) => {
    const { Text } = context.components;
    return <Text>{context.statuses.pr ?? context.model.displayName}</Text>;
  });

  void update();
  const timer = setInterval(update, 60_000);
  return () => clearInterval(timer);
}
```

## macOS currently playing track

```tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.ui.customStatuslineRenderer) return;

  const update = async () => {
    try {
      const script = 'tell application "Music" to if it is running then artist of current track & " - " & name of current track';
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      const music = stdout.trim();
      music ? letta.ui.setStatus("music", music) : letta.ui.clearStatus("music");
    } catch {
      letta.ui.clearStatus("music");
    }
  };

  letta.ui.setStatuslineRenderer((context) => {
    const { Text } = context.components;
    return <Text>{context.statuses.music ?? context.agent.name}</Text>;
  });

  void update();
  const timer = setInterval(update, 15_000);
  return () => clearInterval(timer);
}
```
