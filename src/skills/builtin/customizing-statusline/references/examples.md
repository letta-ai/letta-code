# Statusline Examples

Use these as patterns, not mandatory templates. Keep the final mod focused on the user's request. All register at `order: 0` (the primary line) and return text composed with `row`/`columns`/`chalk`.

## Agent and model

```tsx
export default function activate(letta) {
  if (!letta.capabilities.ui.panels) return;

  const panel = letta.ui.openPanel({
    id: "statusline",
    order: 0,
    render: ({ width, agent, model, row, chalk }) =>
      row(
        chalk.cyan(agent.name ?? "Letta"),
        chalk.dim(model.displayName ?? "no model"),
        width,
      ),
  });

  return () => panel.close();
}
```

## Git branch with fallback

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
    render: ({ width, agent, row, chalk }) =>
      row(branch ? chalk.green(`git ${branch}`) : (agent.name ?? "Letta"), "", width),
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

## Full row with internal right alignment

```tsx
export default function activate(letta) {
  if (!letta.capabilities.ui.panels) return;

  const panel = letta.ui.openPanel({
    id: "statusline",
    order: 0,
    render: ({ width, agent, model, row, chalk }) =>
      row(
        chalk.dim("Press / for commands"),
        `${agent.name ?? "Letta"} \u00b7 ${model.displayName ?? "no model"}`,
        width,
      ),
  });

  return () => panel.close();
}
```

## GitHub PR number via `gh`

```tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.ui.panels) return;

  let pr = "";

  const panel = letta.ui.openPanel({
    id: "statusline",
    order: 0,
    render: ({ width, model, row }) => row(pr || (model.displayName ?? ""), "", width),
  });

  const update = async () => {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", "--json", "number,title", "--jq", "\"#\\(.number) \\(.title)\""],
        { cwd: process.cwd() },
      );
      pr = stdout.trim();
    } catch {
      pr = "";
    }
    panel.update();
  };

  void update();
  const timer = setInterval(update, 60_000);
  return () => {
    clearInterval(timer);
    panel.close();
  };
}
```

## macOS currently playing track

```tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.ui.panels) return;

  let music = "";

  const panel = letta.ui.openPanel({
    id: "statusline",
    order: 0,
    render: ({ width, agent, row, chalk }) =>
      row(music ? chalk.magenta(music) : (agent.name ?? "Letta"), "", width),
  });

  const update = async () => {
    try {
      const script =
        'tell application "Music" to if it is running then artist of current track & " - " & name of current track';
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      music = stdout.trim();
    } catch {
      music = "";
    }
    panel.update();
  };

  void update();
  const timer = setInterval(update, 15_000);
  return () => {
    clearInterval(timer);
    panel.close();
  };
}
```
