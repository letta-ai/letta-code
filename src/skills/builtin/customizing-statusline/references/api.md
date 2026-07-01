# Statusline Mod API

Use this reference when creating or editing `~/.letta/mods/statusline.tsx`.

## Location

```text
~/.letta/mods/statusline.tsx
```

This is a trusted, user-owned global mod file. Project mods are intentionally unsupported for now.

## Activation

Export a default function or named `activate` function. The statusline is a panel at `order: 0`:

```tsx
export default function activate(letta) {
  if (!letta.capabilities.ui.panels) return;

  const panel = letta.ui.openPanel({
    id: "statusline",
    order: 0, // primary line: overrides the built-in agent · model
    render: ({ width, agent, model, row, chalk }) => {
      const left = chalk.cyan(agent.name ?? "Letta");
      const right = chalk.dim(model.displayName ?? "no model");
      return row(left, right, width);
    },
  });

  return () => panel.close();
}
```

## API

```ts
letta.capabilities.ui.panels: boolean

letta.ui.openPanel(options: {
  id: string;
  order?: number; // default 100
  render: (ctx) => string | string[];
}): { close(): void; update(opts?: { order?: number }): void }

letta.ui.closePanel(id: string): void
```

`openPanel` registers (or replaces, by `id`) a panel. `render` returns the panel body as a string or an array of strings (one per line). Call the returned handle's `update()` to re-render after state changes, and `close()` to remove it.

## Order placement

`order` is a signed coordinate around the input:

- `order > 0` — above the input. Higher numbers render nearer the top. Default when omitted is `100`.
- `order === 0` — the primary line just below the input. Overrides the built-in `agent · model`. Use this for the statusline.
- `order < 0` — stacks below the primary line. `-1` sits closest to it, more-negative lower.

A panel whose `render` returns empty (`""` or `[]`, or only blank lines) is hidden entirely — no blank row.

## Render context

```ts
render(ctx: {
  width: number;            // visible columns available to the panel
  agent: { id, name };      // live at render time
  model: { id, displayName, provider, reasoningEffort };
  row(left, right, width): string;     // left + right, right-aligned, ANSI-aware
  columns(parts: string[], width): string; // spread parts evenly, ANSI-aware
  chalk: ChalkInstance;     // color helper
}): string | string[]
```

- `row`/`columns` measure visible width with ANSI stripped, so chalk-colored segments align correctly.
- The host clips each line to `width` and caps total height; the mod owns layout within that.

## Render rules

- `render` must be synchronous and side-effect-free.
- Do not run shell commands, network requests, file reads, or awaits inside `render`.
- Do async work in setup code or intervals, store the result in a closure variable, then call `panel.update()`.
- Return `""` (or `[]`) to render nothing.

## Async state pattern

Use Node/Bun APIs directly from the trusted mod file. Do not assume helper methods like `letta.shell` exist.

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
    render: ({ width, agent, row, chalk }) => {
      const left = branch ? chalk.green(`\u2442 ${branch}`) : (agent.name ?? "Letta");
      return row(left, "", width);
    },
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

## Full-row layout

There is no host left/right API. Build left/right alignment inside `render` with `row`:

```tsx
render: ({ width, agent, model, row, chalk }) =>
  row(chalk.dim("Press / for commands"), `${agent.name ?? "Letta"} \u00b7 ${model.displayName ?? ""}`, width),
```

Use `columns` for three or more evenly-spread segments:

```tsx
render: ({ width, columns }) => columns(["left", "middle", "right"], width),
```

## Reload behavior

After editing `~/.letta/mods/statusline.tsx`, tell the user to run:

```text
/reload
```

The runtime tracks mod loading so a custom statusline does not flash back to the built-in default during reload.
