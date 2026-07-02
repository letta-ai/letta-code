# Mod UI recipes

UI capabilities are optional. Always guard UI work with `letta.capabilities.ui.panels` when writing portable mods.

For UI that belongs to a larger command/event mod, also read `architecture.md` for cleanup and composition patterns.

## Capabilities

```ts
letta.capabilities.ui.panels
```

- `panels`: text blocks placed around the input bar (the only mod UI surface). Desktop/listener disables panel UI.

## Panels

Panels are app/TUI-global today. Desktop/listener disables panel UI; future scoped panels need an explicit design instead of sharing this global registry across panes/conversations.

```ts
if (letta.capabilities.ui.panels) {
  let status = "Working…";
  const panel = letta.ui.openPanel({
    id: "my-mod",
    order: 100,
    render: ({ width }) => status,
  });

  status = "Done";
  panel.update(); // re-invokes render with the current width
  setTimeout(() => panel.close(), 5_000);
}
```

`render` returns the panel body: a string or string array (one entry per line). The host owns the region — it clips each line to `width` and caps total height — so the mod owns layout: use `width`, `row(left, right, width)`, and `columns(parts, width)` to align. The host re-invokes `render` whenever you call `panel.update()` and on terminal resize. Keep `render` cheap and side-effect-free; for longer text use a command `output` instead.

### Placement by `order`

`order` is a signed coordinate around the input:

- `order > 0` — above the input, higher nearer the top (default `100`).
- `order === 0` — the primary line just below the input, overriding the built-in `agent · model`. This is the statusline slot; use `customizing-statusline` for that work.
- `order < 0` — stacks below the primary line, `-1` closest.

A panel whose `render` is empty (`""`, `[]`, or only blank lines) is hidden.

### Render context

```ts
render(ctx: {
  width: number;
  agent: { id, name };
  model: { id, displayName, provider, reasoningEffort };
  row(left, right, width): string;
  columns(parts: string[], width): string;
  chalk: ChalkInstance;
}): string | string[]
```

`row`/`columns` are ANSI-aware, so chalk-colored segments align correctly.

Close panels when they are transient, and close/replace long-lived panels from the activation disposer if reload should remove them.

### Commands that open panels

If a command's `run()` opens a panel, guard the command **registration** on `letta.capabilities.ui.panels` — not just the `openPanel` call:

```ts
export default function activate(letta) {
  if (!letta.capabilities.commands) return;
  if (!letta.capabilities.ui.panels) return; // panel-only command: skip where panels are unsupported

  return letta.commands.register({
    id: "mycommand",
    description: "…",
    run() {
      const panel = letta.ui.openPanel({ /* … */ });
      // …
      return { type: "handled" };
    },
  });
}
```

Guarding only the `openPanel` call is not enough. The desktop listener has `commands: true` but `ui.panels: false`, so a command registered there is advertised in the command picker while its panel work no-ops — the user sees a command that runs and does nothing. Gating the registration keeps panel-only commands out of hosts that can't render them.

## Timers and cleanup

```ts
export default function activate(letta) {
  if (!letta.capabilities.ui.panels) return;

  let clock = new Date().toLocaleTimeString();
  const panel = letta.ui.openPanel({
    id: "clock",
    order: 100,
    render: ({ width, row }) => row("clock", clock, width),
  });

  const timer = setInterval(() => {
    clock = new Date().toLocaleTimeString();
    panel.update();
  }, 30_000);

  return () => {
    clearInterval(timer);
    panel.close();
  };
}
```
