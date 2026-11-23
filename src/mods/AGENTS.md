# Extension & Mod System

## Architecture

```
AppCoordinator
  -> Adapter (extension-adapter)     , app-facing lifecycle, context, reload
    -> Engine (extension-engine)     , loads extensions, maintains registry
      -> Extension code             , user-authored .ts/.tsx files
```

- **Adapter** owns app-facing lifecycle: create/reload/dispose, loading flags,
  current mutable context, React subscription surface.
- **Engine** owns extension mechanics: discover/transpile/import/activate,
  create the `letta` API object, maintain registry, invoke event handlers,
  record diagnostics.
- **Registry** = engine-owned snapshot of extension-contributed things.
  Extensions write indirectly through `letta.*` APIs. App reads snapshot to
  render/use them.

Key files:
- `src/extensions/extension-adapter.ts` , types, `hasExtensionSources`, `createExtensionAdapter`
- `src/extensions/extension-engine.ts` , engine, loads extensions, maintains registry
- `src/extensions/conversation-handle.ts` , scoped conversation handle (`fork`, `getHistory`, `sendMessageStream`)
- `src/extensions/disabled-extension-adapter.ts` , null-object adapter when extensions disabled

## Kill Switch

- `--no-extensions` CLI flag
- `LETTA_DISABLE_EXTENSIONS=1` environment variable

## Mod vs Extension Location

- **Mods** go in `~/.letta/mods/`, simple `.ts` files, auto-loaded on session
  start or `/reload`.
- **Extensions** go in `~/.letta/extensions/`, legacy `.ts`/`.tsx` files
  compiled to `.mjs` via TypeScript transpilation.
- `resolveDefaultGlobalModsDirectory` prioritizes `~/.letta/mods/` over
  `~/.letta/extensions/` when both exist. Extensions get silently shadowed.
- Compiled extensions cached in `~/.letta/extension-cache/`.
- Feature-checked mod files (checking `letta.capabilities.*` before calling
  `letta.ui.*`) are safe to leave in `~/.letta/mods/` across different builds.

## Capabilities

Extensions check `letta.capabilities.*` before using surfaces. When a capability
is `false`, the API is stubbed to no-op (not throw). Key capabilities:
`events.lifecycle`, `events.turns`, `ui.panels`, `ui.dialogs`, `commands`,
`tools`, `providers`.

Listener (`LISTENER_MOD_CAPABILITIES`): `events.turns: false`, `ui.panels:
false`, `ui.dialogs: false`. Panel-based mod commands show in the picker but
silently fail to render.

## Events

Lifecycle: `conversation_open` / `conversation_close` (NOT `session_start` /
`session_shutdown`).

Turn: `turn_start` (pre-send, handlers can mutate input) / `turn_end`
(post-turn, handlers can return `{ continue: "..." }` effect).

- `turn_start` handlers receive the raw mutable `MessageCreate[]` input array.
  Both mutation and functional return styles work. Engine applies returned
  `{ input }` immediately so next handler sees updated input.
- Rollback on handler error: input restored before continuing to next handler.
- `null` conversation ID before first message, guard with
  `if (ctx.conversation.id)`.
- First-handler-wins for effect-returning events: first handler returning an
  effect wins; subsequent handlers are shadowed.
- `llm_end`/`turn_end` don't fire on errors. No mod error event exists. No
  same-turn retry.

## Panel & Statusline (Unified)

`openPanel({ id, order, render }) -> { update, close }` is the sole mod UI
primitive. `openStatusline` is folded into `openPanel`.

**Signed-order coordinate:**
- `0` = primary (reserved `"primary"` id, replaces built-in `agent . model`)
- `1` = product-status replacement (singleton, newest-wins)
- Negative = below input, positive > 1 = above input (additive stacking)
- Higher number = higher on screen. Sort descending, ties -> most-recently-updated.

**Render function:** `render: (ctx) => string | string[]`. Must be cheap and
pure, no I/O, no side effects. Host calls it on frame cadence.

**Key-based lifecycle:** upserts by `id`. `closePanel(id)` removes. Handle
methods: `{ update: () => void; close: () => void }`. `update()` is a dirty flag,
not data passing, state works via closure mutation.

**Render context:** `ModPanelRenderContext` extends `ModContext`, panels get
the full live mod context plus `width`, `row(left, right, width)`,
`columns(items, width)`, `chalk`.

**Legacy `{ content }` API silently no-ops.** Runtime validation emits a warning
diagnostic. When debugging a mod that "does nothing", check whether it uses
`content` instead of `render`.

**Async commands pattern:** fetch data outside render, store in closure, call
`panel.update()` when data arrives, `render: () => state.result ?? loading_text`.

## Mod Dialogs

`letta.ui.select({ message, options }) -> Promise<string | null>` , blocking,
modal, captures keyboard focus. Renders below input, preempts statusline +
below panels. ESC resolves `null`.

- `ui.dialogs` capability gated. When disabled: resolves `null` (not throw).
- Self-dequeuing resolver: promise resolve function removes its own entry from
  the queue. Without this, zombie dialogs persist.
- Input blocking parity: must set `inputEnabled = false` in AppCoordinator
  during active dialog, not just collapse input visually. Otherwise main input
  and dialog both catch Enter.
- Desktop transport: mod dialogs are registry-keyed by `id`, not tool calls, so
  they can't ride the permission channel. Desktop needs new WS commands.

## Mod Secrets

`ctx.secret(KEY, { envFallback: true })` , minimal primitive, agent-scoped, env
fallback opt-in, redacted from output. Secrets are substituted at command
dispatch time, not as persistent env vars. Only literal `$NAME` references work
(not `${NAME}`).

## Mod Package Publishing

- npm publish requires `./` prefix for package path.
- `git:` prefix for GitHub-installed mods.
- Package manifest: capability ID sourced from manifest, fail-closed.
- Version bumping for breaking API migrations: bump package version, set
  `engines.lettaCodeCli` to `>= N+1` where N is the current released Letta Code
  version (the breaking change isn't released yet).

## Subagent Lifecycle API

- `ctx.subagents.list()` , returns fuller lifecycle items (type, status,
  durationMs, agentId, visibleInTranscript). No `active` field (use `pending ||
  running`). No `surface` field (use JS `.filter()`). No filter sugar.
- `ctx.backgroundAgents` , slim projection (`type`, `status`, `durationMs`,
  `agentId`). Sufficient for minimal text-only rendering.
- Both read from the same source (`subagentLifecycleSnapshot` in `InputRich`).
  Difference is projection depth.
- Completed/error agents retained ~30s before cleanup. Consumers must filter on
  `status` if they only want active agents.

## Product-Status Panel

- `order: 1` = product-status replacement (singleton, newest-wins).
- Built-in default panel injected by `InputRich` when no user panel occupies
  `order: 1`.
- User mod at `order: 1` suppresses the built-in default.
- `ctx.link(label, url)` helper for OSC-8 hyperlinks. In tmux, OSC-8 doesn't
  work, default panel omits URL entirely.
- Spinner state is host-owned, fed to default panel via options. A user mod at
  `order: 1` runs its own `setInterval` + `panel.update()` to animate.
