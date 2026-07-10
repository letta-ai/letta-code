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

- `order > 1` — additive panels above the input, higher nearer the top (default `100`).
- `order === 1` — replaces the default dreaming/reflection indicator above the input. Use this only when intentionally overriding that row; otherwise use `order > 1`.
- `order === 0` — the primary line just below the input, overriding the built-in `agent · model`. This is the statusline slot; use `customizing-statusline` for that work.
- `order < 0` — stacks below the primary line, `-1` closest.

A panel whose `render` is empty (`""`, `[]`, or only blank lines) is hidden.

### Render context

```ts
render(ctx: {
  width: number;
  agent: { id, name };
  model: { id, displayName, provider, reasoningEffort };
  backgroundAgents: Array<{
    type: string;
    status: string;
    durationMs: number;
    agentId: string | null;
  }>;
  subagents: { list(): SubagentLifecycleItem[] };
  row(left, right, width): string;
  columns(parts: string[], width): string;
  link(label: string, url: string): string;
  chalk: ChalkInstance;
}): string | string[]
```

`row`/`columns` are ANSI-aware, so chalk-colored segments and OSC-8 links align correctly. Use `link(label, url)` when a compact label should hyperlink to a URL without rendering the whole URL.

Close panels when they are transient, and close/replace long-lived panels from the activation disposer if reload should remove them.

### Panel use case: dreaming indicator overrides

When a user asks to change the "dreaming" UI/indicator, the reflection status above the input, or to add the full background-agent URL, use an `order: 1` panel replacement. The user should not need to know any internal row/component name.

Checklist:

- Open a panel with `order: 1`, not an additive panel.
- Read active hidden background agents from `ctx.backgroundAgents`; filter by `status` (`pending`/`running`).
- Use `agent.agentId` to build `https://app.letta.com/chat/${agent.agentId}`.
- If the user asks for the full URL, render visible text; do not use `ctx.link()` because it hides the URL behind OSC-8.
- If preserving animation, own the timer and call `panel.update()`; clean up timer and panel in the disposer.
- Keep `render()` pure: do not call diagnostics or mutate external state from render.

Critical shape:

```ts
const panel = letta.ui.openPanel({
  id: "dreaming-url",
  order: 1,
  render(ctx) {
    const agent = ctx.backgroundAgents.find(
      (a) => a.status === "pending" || a.status === "running",
    );
    if (!agent) return "";

    const url = agent.agentId
      ? `https://app.letta.com/chat/${agent.agentId}`
      : null;
    // Render spinner/label/elapsed, plus visible URL if requested.
  },
});
```

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
