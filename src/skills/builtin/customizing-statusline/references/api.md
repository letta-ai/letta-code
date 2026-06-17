# Statusline Mod API

Use this reference when creating or editing `~/.letta/mods/statusline.tsx`.

## Location

```text
~/.letta/mods/statusline.tsx
```

This is a trusted, user-owned global mod file. Project mods are intentionally unsupported for now.

## Activation

Export a default function or named `activate` function:

```tsx
export default function activate(letta) {
  if (!letta.capabilities.ui.customStatuslineRenderer) return;

  letta.ui.setStatuslineRenderer((context) => {
    const { Text } = context.components;
    return <Text>{context.agent.name} · {context.model.displayName}</Text>;
  });
}
```

## API

```ts
letta.capabilities.ui.statusValues: boolean
letta.capabilities.ui.customStatuslineRenderer: boolean

letta.ui.setStatus(key: string, value: string | null | undefined | ((context) => string | null)): void
letta.ui.clearStatus(key: string): void
letta.ui.setStatuslineRenderer(renderer: StatuslineRenderer | ((context) => ReactNode | null)): void
```

`setStatus` stores named string values. Renderers read evaluated values from `context.statuses`.

```tsx
letta.ui.setStatus("branch", "main");

letta.ui.setStatuslineRenderer((context) => {
  const { Text } = context.components;
  return <Text>{context.statuses.branch}</Text>;
});
```

## Renderer rules

- Renderer owns the entire idle bottom row.
- Renderer must be synchronous.
- Do not run shell commands, network requests, file reads, or awaits inside render.
- Do async work in setup code or intervals, store results with `setStatus`, then render `context.statuses`.
- Return `null` only when intentionally rendering nothing.

## Async state pattern

Use Node/Bun APIs directly from the trusted mod file. Do not assume helper methods like `letta.shell` exist.

```tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.ui.customStatuslineRenderer) return;

  const update = async () => {
    try {
      const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: process.cwd(),
      });
      if (letta.capabilities.ui.statusValues) {
        letta.ui.setStatus("branch", stdout.trim());
      }
    } catch {
      if (letta.capabilities.ui.statusValues) {
        letta.ui.clearStatus("branch");
      }
    }
  };

  letta.ui.setStatuslineRenderer((context) => {
    const { Text } = context.components;
    const branch = context.statuses.branch;
    return <Text>{branch ? `branch ${branch}` : context.agent.name}</Text>;
  });

  void update();
  const timer = setInterval(update, 30_000);

  return () => {
    clearInterval(timer);
    if (letta.capabilities.ui.statusValues) {
      letta.ui.clearStatus("branch");
    }
  };
}
```

## Context fields

The app statusline render context source types live near:

```text
src/cli/display/statusline/types.ts
src/cli/display/statusline/context.ts
```

Common fields:

```ts
context.components      // Display components such as Text, Box, Spacer
context.statuses        // evaluated mod status strings
context.app.version
context.workspace.cwd
context.workspace.currentDir
context.workspace.projectDir
context.agent.name
context.agent.id
context.model.id
context.model.displayName
context.model.provider
context.model.reasoningEffort
context.permissionMode
context.terminalWidth
context.contextWindow.usedPercentage
context.contextWindow.remainingPercentage
context.cost.totalDurationMs
context.cost.totalCostUsd
context.reflection
context.memfs
context.backgroundAgents
context.rawPayload      // compatibility payload for advanced cases
```

Prefer semantic fields over `rawPayload` unless migrating old command statuslines.

## Full-row layout

New statuslines do not have a host left/right API. To create left/right visual alignment, do it inside the renderer:

```tsx
return (
  <Box flexDirection="row">
    <Box flexGrow={1}>
      <Text>left content</Text>
    </Box>
    <Text>right content</Text>
  </Box>
);
```

## Reload behavior

After editing `~/.letta/mods/statusline.tsx`, tell the user to run:

```text
/reload
```

The runtime tracks mod loading separately from “no custom statusline,” so a custom statusline should not flash back to the built-in default during reload.
