# Mod UI recipes

UI capabilities are optional. Always guard UI work with the matching `letta.capabilities.ui.*` flag when writing portable mods.

For UI that belongs to a larger command/event mod, also read `architecture.md` for cleanup and composition patterns.

## Capabilities

```ts
letta.capabilities.ui.panels
letta.capabilities.ui.dialogs
```

- `panels`: text blocks placed around the input bar. Desktop/listener disables panel UI.
- `dialogs`: blocking question prompts via `letta.ui.select`. Desktop/listener disables dialog UI (calls resolve to `null`).

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

## Blocking dialogs (`letta.ui.select`)

`letta.ui.select` asks the user one or more questions and blocks until they answer or cancel. It renders through the same component as the built-in `AskUserQuestion` tool, so the UX is identical and it takes over the input region while open. Use it from a command's `run` (or any async mod code) when you need a choice before continuing.

```ts
export default function activate(letta) {
  if (!letta.capabilities.commands) return;

  return letta.commands.register({
    id: "pick",
    description: "Ask the user to pick something",
    showInTranscript: false,
    async run() {
      // Guard: dialogs are unavailable on non-TUI surfaces.
      if (!letta.capabilities.ui.dialogs) {
        return { type: "output", output: "dialogs not supported here" };
      }

      const answer = await letta.ui.select({
        questions: [
          {
            header: "Color",
            question: "Pick a color",
            options: [
              { label: "red", description: "warm" },
              { label: "blue", description: "cool" },
            ],
          },
        ],
      });

      if (!answer) return { type: "output", output: "cancelled" };
      return { type: "output", output: `picked ${answer["Pick a color"]}` };
    },
  });
}
```

### Question shape

```ts
letta.ui.select({
  questions: [{
    question: string;   // shown to the user, and the key the answer is returned under
    header: string;     // short chip label
    options?: { label: string; description?: string }[]; // omit for a free-text question
    multiSelect?: boolean;  // many-of-N (labels come back comma-joined)
    allowOther?: boolean;   // append a "Type something." free-text row (default true)
  }],
}): Promise<Record<string, string> | null>
```

- The result is keyed by each question's `question` string; `null` means the user cancelled (ESC).
- **Single-select**: the answer is the chosen option's `label`, or the typed text if they used the free-text row.
- **Multiselect** (`multiSelect: true`): selected labels are comma-joined (e.g. `"red, blue"`).
- **Free-text**: omit `options` (or rely on the default `allowOther` row) to collect typed input. Set `allowOther: false` to force a choice among the listed options only.
- Pass multiple `questions` to ask them in sequence within one dialog; each answer is keyed by its own `question` string.

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
