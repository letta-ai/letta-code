# Mod UI recipes

UI capabilities are optional. Always guard UI work with `letta.capabilities.ui.*` when writing portable mods.

For UI that belongs to a larger command/event mod, also read `architecture.md` for cleanup and composition patterns.

## Capabilities

```ts
letta.capabilities.ui.panels
letta.capabilities.ui.statusValues
letta.capabilities.ui.customStatuslineRenderer
```

- `panels`: transient text blocks above the input bar.
- `statusValues`: small named status data that renderers or future surfaces can display.
- `customStatuslineRenderer`: TUI-only custom bottom-row renderer. Use `customizing-statusline` for statusline work.

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

`render` returns the panel body: a string or string array (one entry per line). The host owns the region — it clips each line to `width` and caps total height — so the mod owns layout: use `width` to align or build columns. The host re-invokes `render` whenever you call `panel.update()` and on terminal resize. Keep `render` cheap and side-effect-free; keep it short and use command `output` for longer text.

Close panels when they are transient, and close/replace long-lived panels from the activation disposer if reload should remove them.

## Status values

```ts
if (letta.capabilities.ui.statusValues) {
  letta.ui.setStatus("branch", "main");
}
```

Clear status values in disposers if they are owned by timers, events, or external state:

```ts
return () => {
  letta.ui.clearStatus("branch");
};
```

## Timers and cleanup

```ts
export default function activate(letta) {
  if (!letta.capabilities.ui.statusValues) return;

  const update = () => letta.ui.setStatus("clock", new Date().toLocaleTimeString());
  update();
  const timer = setInterval(update, 30_000);

  return () => {
    clearInterval(timer);
    letta.ui.clearStatus("clock");
  };
}
```
