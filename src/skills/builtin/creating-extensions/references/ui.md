# Extension UI recipes

UI capabilities are optional. Always guard UI work with `letta.capabilities.ui.*` when writing portable extensions.

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

```ts
if (letta.capabilities.ui.panels) {
  const panel = letta.ui.openPanel({
    id: "my-extension",
    content: ["Working…"],
    order: 100,
  });

  panel.update({ content: ["Done"] });
  setTimeout(() => panel.close(), 5_000);
}
```

Panel content is plain text: a string or string array. Keep it short; use command `output` for longer text.

## Status values

```ts
if (letta.capabilities.ui.statusValues) {
  letta.ui.setStatus("branch", "main");
}
```

Clear status values in disposers if they are owned by timers or external state:

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
