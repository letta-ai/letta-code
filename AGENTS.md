# letta-code — Agent Guide

This file explains how to work effectively in this repo. It covers the rules enforced by CI, **why each rule exists**, and the workflow conventions that keep the codebase healthy and agent-navigable.

---

## Workflow

1. **Create a worktree** for any non-trivial change — especially if another agent may be working concurrently.
2. **Make your change**, then run `bun run check` and fix all failures before opening a PR.
3. **One PR per logical change.** Don't bundle unrelated changes — harder to revert if something breaks.
4. **Never amend commits.** Always create a new commit.
5. **Check the current branch** before editing files. If in doubt, ask.

---

## Runtime Validation

Development and distribution use different runtimes. `bun run dev` runs the
TypeScript source with Bun, while the published package exposes a Node-targeted
`letta.js` bundle and requires Node 22.19 or newer. When behavior depends on the
runtime, test both the Bun source path and the built Node artifact.

The interactive TUI, headless mode, and websocket listener also have separate
orchestration paths. Changes to shared turn, tool, approval, permission, or
transcript behavior must identify and run the focused tests for every affected
path. `bun run check` is always required, but it does not replace those behavior
tests.

---

## Rules and Why They Exist

These are the rules enforced by CI and the pre-commit hook, with the reasoning behind each. Understanding the *why* lets you make good decisions in ambiguous cases the rules don't explicitly cover.

### No `../` parent imports — use `@/`

**Rule:** All cross-directory imports must use the `@/` alias (`@/` maps to `src/`). Relative parent paths (`../`) are banned and blocked by pre-commit.

**Why:** Agents navigate codebases by searching. `import { getBackend } from "@/backend"` is immediately grep-discoverable anywhere in the repo. `import { getBackend } from "../../backend"` requires resolving the path from the current file's location — fragile to moves and opaque to search. Consistent absolute paths also make codemods reliable: a rename script can find all import sites with a simple grep.

```ts
// correct
import { getBackend } from "@/backend";
import { isDebugEnabled } from "@/utils/debug";

// wrong — blocked by pre-commit hook
import { getBackend } from "../../backend";
```

**Four files are exempt** (they legitimately live above `src/`): `src/version.ts`, `src/index.ts`, `src/cli/cli.ts`, `src/cli/app/App.tsx`. Same-directory `./` imports are always fine.

---

### Kebab-case `.ts` filenames, PascalCase `.tsx`

**Rule:** `.ts` source files use kebab-case (`local-store.ts`). `.tsx` component files use PascalCase (`AgentSelector.tsx`). Enforced by `scripts/check-filename-casing.js` in pre-commit and CI.

**Why:** Agents evaluate code quality by how searchable a codebase is. Inconsistent casing (`localStore.ts`, `LocalStore.ts`, `local-store.ts`) means a grep pattern that works for one file fails for another. macOS's case-insensitive filesystem makes this worse — `existsSync("bash.ts")` returns `true` when `Bash.ts` exists, silently breaking rename scripts. Kebab-case `.ts` is also consistent with how Node/Bun resolves modules on Linux CI (case-sensitive).

---

### Named exports everywhere — no default exports

**Rule:** All exports must be named. Default exports are banned (`style/noDefaultExport` biome rule).

**Why:** `grep 'export function AgentSelector'` finds the definition in one shot. With a default export, `export default function` tells you nothing about what the consumer will call it — each import site can rename it arbitrarily, making codebase-wide search unreliable.

---

### `export function` over `export const fn = () =>`

**Rule:** Exported functions must use the `export function` declaration form. `export const fn = () =>` is flagged by `scripts/check-exported-functions.js`. Exception: `.tsx` files wrapping `React.memo()`.

**Why:** Same grep-discoverability principle. `grep 'export function foo'` finds every exported function definition in one query. `export const` mixes function declarations with value exports — agents can't distinguish them without reading the right-hand side. `export function` is also hoisted, making it order-independent.

```ts
// correct
export function computeThing(x: string): number { ... }

// wrong — flagged by check-exported-functions.js
export const computeThing = (x: string): number => { ... }
```

---

### No circular dependencies

**Rule:** Zero circular imports. Enforced by madge (`check:cycles`) in pre-commit and CI. The current baseline is exactly 0.

**Why:** Circular imports cause subtle initialization-order bugs (module A's top-level code runs before module B has finished initializing, even though A imports from B). They also make the dependency graph impossible to reason about — you can't understand a file in isolation if its transitive dependencies loop back to it. The layer map below only has meaning if the graph is acyclic.

---

### Source files stay below 1,000 lines

**Rule:** New source and test files must not exceed 1,000 lines. Existing
oversized files are pinned in `scripts/source-file-size-baseline.json`: they may
shrink, but they may not grow. Lower the baseline in the same change whenever an
oversized file gets smaller, and remove its entry once it reaches the limit.

**Why:** Agents commonly inspect large files in slices and miss distant state,
cleanup, or fallback paths. Responsibility-sized modules make the whole behavior
readable in one pass and give tests an obvious home.

---

### Import from the owner, not an implementation barrel

**Rule:** Import a symbol from the module that defines it. Do not turn concrete
implementation entrypoints such as channel adapters into convenience barrels.
Scoped ownership rules are enforced by `scripts/check-module-ownership.js`.

**Why:** Forwarding exports hide where behavior lives, inflate dependency graphs,
and make agents open orchestration files when they need a small helper. Public
package entrypoints may still re-export their intentional API surface.

---

### Layer boundaries — no upward imports

**Rule:** Files may only import from the same layer or layers below them. Violations are caught by `scripts/check-layer-boundaries.js` in pre-commit and CI.

**Why:** Coupling a lower layer to a higher layer collapses the abstraction. If `backend/` imports from `cli/`, you can no longer use the backend without the UI — tests become harder to write, and changes to the UI risk breaking storage logic. The boundary rules make each layer independently testable and make it safe to change or swap implementations.

```
cli/           ← Ink UI, commands, overlays
websocket/     ← WS listener, session management
agent/         ← domain: conversation, approval, context
tools/         ← tool implementations
backend/       ← API/storage abstraction
providers/     ← LLM adapters (Anthropic, OpenAI)
permissions/   ← pure permission rules (no UI deps)
telemetry/     ← leaf: observability
cron/          ← leaf: scheduler
channels/      ← leaf: integrations
utils/         ← bottom: no domain deps
```

**Enforced rules:**
- `tools/` cannot import from `cli/`
- `backend/` cannot import from `cli/` or `websocket/`
- `providers/` cannot import from `agent/` or `cli/`
- `websocket/listener/` cannot import `backend/api/client` or `backend/api/conversations` directly
- `cli/app/` cannot import `backend/api/conversations` directly

**When adding a new file:** put it in the lowest layer whose dependencies it needs. If you find yourself importing from a higher layer, extract the shared logic into a lower one instead.

---

### Unused locals and parameters are errors

**Rule:** `noUnusedLocals` and `noUnusedParameters` are enabled in `tsconfig.json`. `tsc --noEmit` runs on every commit.

**Why:** Unused symbols mislead agents into thinking something is needed when it isn't. Dead code is the most common source of incorrect assumptions when exploring an unfamiliar codebase. Keeping the signal-to-noise ratio high makes grep results meaningful.

- Use `_prefix` for intentionally unused parameters (`_event`, `_index`).
- Use `void x` to discard a value without creating a binding.
- TypeScript exempts `_`-prefixed names from the check, but NOT function declarations (`function _foo()` is still flagged — use `void` instead).

---

### Test mock isolation

**Rule:** `mock.module()` calls must follow isolation patterns checked by `scripts/check-test-mock-isolation.js`.

**Why:** In Bun, `mock.module()` is applied to the **global module registry** of the worker process — not scoped to the current test file. Mocks leak to all other test files running in the same worker. A mock set in `foo.test.ts` can silently affect `bar.test.ts` if they share a worker, even though `bar.test.ts` never asked for it. This produces failures that only appear in the full test suite, not in isolation.

Practical rules:
- Prefer dependency injection or object-level stubbing over module-level mocking.
- Don't mock broad shared modules (`settings-manager`, telemetry, etc.).
- If a test file must use `mock.module()`, register it with a reason in `scripts/isolated-unit-tests.json`; `scripts/run-unit-tests.cjs` will run it in a standalone Bun process, and the mock-isolation check rejects unregistered top-level mocks.
- If a test passes alone but fails in `bun test src/`, suspect mock leakage first.

---

## Directory Guides

Some directories carry their own binding `AGENTS.md` with rules that override
generic instincts. Read the local guide before changing code there:

- `src/cli/AGENTS.md` — Ink rendering, approvals, and interactive input rules
  for the TUI.
- `src/websocket/listener/AGENTS.md` — turn lifecycle, leases, approvals, queue
  gating, and where listener tests belong.
- `src/channels/AGENTS.md` — gateway policy placement and the pure-logic
  package subpaths shared with remote hosts.
- `src/channels/slack/AGENTS.md` — Slack module ownership, the progress
  contract, and live verification requirements.

---

## Placing New Files

| What you're adding | Where it goes |
|--------------------|---------------|
| Ink component (UI only) | `src/cli/components/` |
| Command handler | `src/cli/commands/` |
| Hook used in App | `src/cli/app/` or `src/cli/hooks/` |
| WS listener logic | `src/websocket/listener/` |
| Agent/conversation domain logic | `src/agent/` |
| Tool implementation | `src/tools/impl/` |
| Backend abstraction | `src/backend/` |
| LLM provider adapter | `src/providers/` |
| Pure utility (no domain deps) | `src/utils/` |
| Shared test helpers | `src/test-utils/` |
| Build/lint scripts | `scripts/` |

Test files live **next to their source** (`local-store.test.ts` next to `local-store.ts`), not in a separate `tests/` directory.

---

## Reference

### Commands

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Full check suite | `bun run check` |
| Auto-fix lint/format | `bun run fix` |
| Type check only | `bun run typecheck` |
| Run a single test file | `bun test src/path/to/file.test.ts` |
| Run all unit tests | `bun test $(find src -name "*.test.ts" \| grep -v integration-tests)` |
| Dev mode | `bun run dev` (sets `LETTA_DEBUG=1` by default) |

`bun run fix` only auto-fixes biome violations (format + lint autofixes). The
architectural checks and TypeScript errors need manual fixes. The pre-commit hook
also rejects staged parent-relative imports (`../`); use the `@/` alias.

### Check Suite (what each check does)

1. **cycles** — `madge --circular src/`; must be exactly 0
2. **boundaries** — `scripts/check-layer-boundaries.js`; checks import direction per layer
3. **exported-functions** — `scripts/check-exported-functions.js`; flags `export const fn =`
4. **filename-casing** — `scripts/check-filename-casing.js`; enforces source naming conventions
5. **source-file-size** — `scripts/check-source-file-size.js`; enforces the 1,000-line ceiling and ratchet
6. **module-ownership** — `scripts/check-module-ownership.js`; protects orchestration modules from barrel imports/exports
7. **test-mock-isolation** — `scripts/check-test-mock-isolation.js`; flags unsafe `mock.module` patterns
8. **test-coverage** — `scripts/check-test-coverage.cjs`; checks source/test coverage policy
9. **skill-frontmatter** — checks every `SKILL.md` has a non-empty `name:` header
10. **bundled-skill-scripts** — validates scripts shipped with bundled skills
11. **biome** — format + lint across source files
12. **typescript** — full `tsc --noEmit`

### Environment Variables

| Variable | Effect |
|----------|--------|
| `LETTA_DEBUG=1` | Verbose debug output (default in `bun run dev`) |
| `LETTA_DEBUG=0` | Suppress debug output even in dev mode |
| `LETTA_LOCAL_BACKEND_EXPERIMENTAL=1` | Enable local in-process backend |
| `LETTA_LOCAL_BACKEND_EXECUTOR=deterministic` | Use fake deterministic executor (for tests) |
| `LETTA_LOCAL_BACKEND_DIR` | Local-backend storage root (defaults to `~/.letta/lc-local-backend`) |

When manually smoke-testing the local backend (`letta --backend local` or
`bun run dev --backend local`), set `LETTA_LOCAL_BACKEND_DIR` to a temporary
directory first. Otherwise the run reads and mutates your real
`~/.letta/lc-local-backend` provider, auth, and transcript state.

### Known Gotchas

- **Prettier is not used.** Biome is the sole formatter. Do not add Prettier — they conflict.
- **`new URL("./path.ts", import.meta.url)` in tests** is not a static import and is not caught by the `@/` import codemod. Scan for `new URL(` manually when moving source files.
- **grep exits 1 on no matches** — pre-commit hooks use `|| true` on grep pipes to prevent false failures on clean commits.
- **macOS case-insensitive FS** — `existsSync("bash.ts")` returns `true` when `Bash.ts` exists. Rename scripts that use `existsSync` to check kebab-case targets will silently skip single-word PascalCase files. Use `git mv` for renames.
- **Native modules can behave differently under Bun and Node.** The published package runs the bundled `letta.js` under Node (>= 22.19), while `bun run dev` runs the source under Bun. Example: `node-pty` is loaded directly under Node but through a Node bridge process under Bun, because its native handles do not integrate reliably with Bun's event loop (`src/tools/impl/shell-runner.ts`). Test runtime-sensitive code on both paths.
- **`setTimeout(fn, 0)` fires on the next tick, not never.** For "no timeout" behavior, check the timeout value before scheduling the timer instead of passing 0.
- **Extend `@letta-ai/letta-client` types instead of redeclaring them.** Use the SDK's `ToolCall`, `StopReasonType`, and similar wire types directly; do not duplicate wire shapes or cast with `as any`.
- **Package subpath entrypoints use relative imports and dedicated entry files.** Library entries (`src/agent-presets.ts`, `src/channels-*.ts`, `src/app-server-client.ts`) are bundled separately and their emitted `.d.ts` files go through an alias rewrite in `build.js`; anything reachable from a browser-targeted entry must stay free of node builtins and backend/provider imports. Consumers on `moduleResolution: "node"` resolve subpath types through `typesVersions` in `package.json`, so new subpaths need entries there too.
- **When changing a function from swallowing errors to throwing**, check every caller; each may need different handling.

- **Headless duplicates App.tsx logic.** `headless.ts` has its own approval
  handling loop (not shared with App.tsx). When making changes to
  streaming/approval logic, check if headless.ts needs matching changes.
- **`protocol_v2.ts` changes propagate to consumers.** Used by LCD (Letta Cloud
  Desktop). Changes likely need to propagate upstream.
- **Agent loop naming is confusing.** `letta_agent_v1` is the agent_type name
  but runs on `letta_agent_v3.py`. `letta_agent_v2.py` is summarization retry
  wrapper. Don't mix up naming in code review.
- **Token counting differs by provider.** Anthropic: `input_tokens` excludes
  cached (total = input + cache_creation + cache_read). Gemini:
  `prompt_token_count` already includes cached. Getting this wrong breaks
  summarizer triggering.
- **OTID workaround.** Backend returns same OTID for reasoning and tool_call in
  same step. Client suffixes OTID with message type to differentiate. Without
  this, reasoning before tool calls gets swallowed.
- **Agent-adapter mod import cache sharing.** Agent adapters share the default
  mod import cache. Two agents loading the same mod code share top-level module
  state. Per-agent isolation doesn't extend to mod-level mutable state.
- **`/reload` does not reload app TypeScript source.** Only re-reads mods and
  settings. Changes to app TypeScript files require a full process restart.
  New slash commands added to the registry also require a full restart.
- **`settingsManager` is a global singleton in tests.** State persists between
  tests. Tests that use it must call `await settingsManager.reset()` and
  `await settingsManager.initialize()` before running. Redirect `HOME` to a
  temp dir before `initialize()` to avoid reading the user's actual settings.
- **Prettier version mismatch.** Local `bunx prettier` may resolve to a newer
  version than CI uses. Always format with the pinned version from
  `package.json`.
- **`bun.lock` churn.** Running `bun install` in a worktree may add
  `"configVersion": 0` due to a newer Bun version. Scrub with `git checkout
  main -- bun.lock` when the PR has no real package.json change.
- **Desktop setup: never bare `npm install`.** Running bare `npm install` in the
  letta-code workspace can prune `nx-electron` (installed `--no-save` at repo
  root), breaking the electron IPC bridge. Always use canonical setup steps
  (`just setup-code-desktop`).
- **Remote log rotation.** `~/.letta/logs/remote/` grows unbounded. Long
  desktop sessions can produce 50GB+ in a single log file. Not yet fixed.
- **`*Rich.tsx` naming inversion.** The `*Rich.tsx` files are the ACTIVE
  components, not the plain-named siblings. `App.tsx` imports Rich files and
  renames them on import. The non-Rich files were dead stubs. When auditing a
  `*Rich` file, check `App.tsx` imports first.
- **CLI glyph registry.** `src/cli/helpers/glyphs.ts` is the central registry
  for display glyphs. All components import from there.
- **Threading state through app subsystems.** When adding state that crosses
  subsystem boundaries, update ALL context types: `ConversationLoopContext`,
  `SubmitHandlerContext`, `ConversationSwitchingContext`. Missing one causes
  type error (missing definition) or runtime undefined (missing
  destructuring/prop-passing).
- **Settings manager 3-level precedence.** Global, project, local. When adding
  a new configurable setting, add the field to ALL THREE settings interfaces,
  add to project settings loading, and add collision routing in `updateSettings`.

---

## Code Review Signals

When reviewing PRs (yours or others'), watch for these patterns. They are the
most common sources of bugs in this codebase.

### TUI Flicker (most common bug)

App.tsx has ~54 `useEffect` calls and spread state. Adding any `useState` or
`useReducer` that updates on keystroke, timer tick, or streaming chunk triggers
re-renders across the entire component tree.

- **Do:** Use refs for values that don't need to trigger renders. Use
  `React.memo()` for static content. Keep state minimal.
- **Don't:** Add `useState`/`useReducer` for UI features that update on every
  keystroke, timer tick, or streaming chunk.
- **Debug:** `LETTA_DEBUG_FLICKER=1` logs re-render triggers to file.
- **Review signal:** any PR adding state to App.tsx, modifying `useEffect` deps,
  or touching approval/rendering components.

### Ink `<Static>` and Double-Printing

Ink's `<Static>` writes to stdout and never erases. Changing the component key
re-mounts and re-renders all items, but previously rendered items persist on
screen, causing duplicate/triple output.

- Do not change the `<Static>` key unless items are already empty.
- Do not render the same output through both buffers (`commandRunner`) and
  `setStaticItems`.
- The accepted exception is an intentional transcript repaint on a display
  toggle (PR #4032): clear the screen first (`CLEAR_SCREEN_AND_HOME`), or use
  vendored Ink's atomic `repaintStaticOutput`. A key change without a preceding
  clear is a double-print risk.

### Tool Call Desync

Two separate accumulation paths (UI buffers vs `StreamProcessor`) for tool call
data can desync. `queuedApprovalResults` not cleared after send -> stale results
resent. Interrupt handler marking tools cancelled even when execution completed.

- **Review signal:** any PR touching approval flow, tool execution, or
  interrupt handling.

### Shell Tool Parity Gap

Policy/UI layer treats all shell variants (`Bash`, `shell_command`,
`ShellCommand`, `run_shell_command`) identically, but the implementation
layer differs. Features added to one tool may be missing from others.

- **Review signal:** any shell tool change, check ALL variants have parity.

### Interrupt Lock / State Cleanup

`EAGER_CANCEL` path and non-EAGER fallback BOTH need to clear ALL state flags
(`isExecutingTool`, `abortControllerRef`, `toolResultsInFlightRef`). Missing
one = permanently busy.

- **Review signal:** interrupt handling, ESC key, tool execution cleanup paths.

### Impossible-State PRs

When a PR addresses a corrupted/impossible state (e.g. `isProcessing=true` but
`loopStatus=WAITING_ON_INPUT`), the fix must trace and fix the **producer**,
the code path that creates the bad state. Teaching the consumer to tolerate
corrupted state is a workaround, not a fix.

**Red flags:**
1. Self-heal guard / state normalizer as primary correctness mechanism (a
   function that checks for an "impossible" state and silently fixes it).
   Acceptable as defense-in-depth + telemetry, but NEVER as the primary fix.
2. Tests that hand-construct the bad state (manually setting contradictory flags)
   only prove the recovery code works, they don't prove the production path is
   fixed.
3. PR description says "exact trigger not proven" or "likely event chain is..."
   , the fix is speculative.
4. Boolean terminal outcomes shared across cleanup layers, use a
   discriminated result (`continue | completed | interrupted | error`) instead.

### pi-ai Ownership Boundary

Letta Code depends on `@earendil-works/pi-ai` specifically so that pi-ai owns:
provider payload conversion, model capability enforcement (e.g. downgrading
image parts for text-only models), the model catalog, and env key resolution.

LC's responsibility ends at a narrow seam: guarantee that only canonical,
type-valid `LocalMessage` content enters the pi Context (ingestion sanitizers in
`local-store.ts`, `toPiMessage`/`toPiMessages` in `pi-stream-adapter.ts`).

**Any PR that adds capability-gated payload sanitization, image stripping,
provider format fixups, or model-capability checks inside the LC adapter/dispatch
layer is suspicious by default.** Before approving:
1. Demand the failing transcript/payload that shows the root cause.
2. Check pi-ai's installed source (`node_modules/@earendil-works/pi-ai/dist`) for
   the same behavior.
3. If LC genuinely needs a belt-and-braces invariant, it belongs at the
   `toPiMessage` boundary and must be capability-independent.
4. Tests that use `as never` / `as any` to inject message shapes are proof no
   typed producer emits those shapes, they pin fiction.

This generalizes: for ANY dependency adopted to own a domain (pi-ai for
providers, letta-client for API types, Ink for rendering), a PR re-implementing
that domain inside letta-code needs explicit justification.

### Leaked Module Mocks in Tests

`mock.module()` is applied to the global module registry of the Bun worker
process, not scoped to the current test file. A mock set in `foo.test.ts` can
silently affect `bar.test.ts` if they share a worker.

- If a test file must use `mock.module()`, register it in
  `scripts/isolated-unit-tests.json` so it runs in a standalone Bun process.
- Save real implementations before mocking, restore in `afterAll`.
- **Review signal:** any test using `mock.module()` without `afterAll`
  restoration, especially if the mocked module is consumed by other test files.

### Don't Rename Existing Test Fixtures

When adding a feature that uses a different provider/entity name, ADD new
tests, don't rename existing test references. Bulk-renaming entity names in
existing tests creates unnecessary diff noise.

- **Review signal:** any PR that bulk-renames entity names in existing tests
  when the rename isn't the PR's purpose.

### Spec Files Are Internal

`SPEC-*.md` files in the repo root are internal working documents, not PR
content. Leave them untracked; don't include in commits.

### Vendored Ink Patches (Red Zone)

`vendor/ink/` and `vendor/ink-text-input/` contain patched Ink runtime
internals. `scripts/postinstall-patches.js` applies these at install time by
exact string match.

- Any PR touching `vendor/ink/build/*` or `scripts/postinstall-patches.js` is a
  red zone: patches are fragile to Ink version bumps, semantically invisible to
  normal review, and coordinated across multiple runtime files.
- Verify the exact matched strings still exist and the throw-on-missing guard is
  preserved.
- After editing vendor files, must run build for changes to take effect.

---

## Extension & Mod System

### Architecture

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

### Kill Switch

- `--no-extensions` CLI flag
- `LETTA_DISABLE_EXTENSIONS=1` environment variable

### Mod vs Extension Location

- **Mods** go in `~/.letta/mods/`, simple `.ts` files, auto-loaded on session
  start or `/reload`.
- **Extensions** go in `~/.letta/extensions/`, legacy `.ts`/`.tsx` files
  compiled to `.mjs` via TypeScript transpilation.
- `resolveDefaultGlobalModsDirectory` prioritizes `~/.letta/mods/` over
  `~/.letta/extensions/` when both exist. Extensions get silently shadowed.
- Compiled extensions cached in `~/.letta/extension-cache/`.
- Feature-checked mod files (checking `letta.capabilities.*` before calling
  `letta.ui.*`) are safe to leave in `~/.letta/mods/` across different builds.

### Capabilities

Extensions check `letta.capabilities.*` before using surfaces. When a capability
is `false`, the API is stubbed to no-op (not throw). Key capabilities:
`events.lifecycle`, `events.turns`, `ui.panels`, `ui.dialogs`, `commands`,
`tools`, `providers`.

Listener (`LISTENER_MOD_CAPABILITIES`): `events.turns: false`, `ui.panels:
false`, `ui.dialogs: false`. Panel-based mod commands show in the picker but
silently fail to render.

### Events

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

### Panel & Statusline (Unified)

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

### Mod Dialogs

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

### Mod Secrets

`ctx.secret(KEY, { envFallback: true })` , minimal primitive, agent-scoped, env
fallback opt-in, redacted from output. Secrets are substituted at command
dispatch time, not as persistent env vars. Only literal `$NAME` references work
(not `${NAME}`).

### Mod Package Publishing

- npm publish requires `./` prefix for package path.
- `git:` prefix for GitHub-installed mods.
- Package manifest: capability ID sourced from manifest, fail-closed.
- Version bumping for breaking API migrations: bump package version, set
  `engines.lettaCodeCli` to `>= N+1` where N is the current released Letta Code
  version (the breaking change isn't released yet).

---

## App-Server Protocol

The v2 app-server protocol (`src/types/protocol_v2.ts`) is the runtime-scoped
protocol for Desktop/app-server. It replaces the v1 session/headless protocol.

### Adding a Protocol Command

1. Add the command interface near related commands in `protocol_v2.ts`.
2. Add it to the `WsProtocolCommand` union type.
3. Add a handler in `src/websocket/listener/message-router.ts`.
4. If it needs a response: add a response interface and add it to
   `WsProtocolMessage` union.
5. Update `src/websocket/listener/protocol-inbound.ts` for outbound parsing.
6. Add an `AppServerClient` helper method + tests in the same PR. Don't ship
   protocol commands without their client ergonomic.
7. Cloud relay forwarding (`FORWARDABLE_COMMAND_TYPES` in letta-cloud) is a
   separate PR.

**Naming:** No "codex" references in codebase/commits/identifiers. Use
"app-server JSON-RPC shape" or "reference app-server shape" if needed.

**AppServerClient ergonomic gap pattern:** When a protocol command family is
added, three surfaces normally need updates: protocol types, inbound validation,
listener handler, **AppServerClient helper** (often missing), **cloud relay
forwarding** (often missing), **desktop response passthrough** (often
missing). Don't eyeball, write a script to diff command types from
`protocol_v2.ts` against `FORWARDABLE_COMMAND_TYPES`.

### Protocol v1 vs v2

- v1 = session/headless: one running session, raw streaming chunks,
  `control_request`/`control_response`. Good for: spawn headless -> send prompt
  -> stream result.
- v2 = app-server: many runtimes in one environment, explicit runtime scope
  (agent_id + conversation_id), state snapshots, typed sideband commands, split
  control/stream channels, idempotency/reconnect/sync.

### `runtime_start`

One-shot entry point: create or resume a runtime scope. Resolution:
`create_agent` present -> create; else require `agent_id` and retrieve.
`conversation_id` present -> retrieve; else create for resolved agent.

Response: `created.agent` / `created.conversation` booleans only. Don't leak
internal implementation details like whether a JS `ConversationRuntime` was
newly allocated.

---

## Filesystem Sandbox

OS-level filesystem sandboxing prevents agents sharing one machine from reading
or writing each other's memory.

### Enforcement Surfaces

1. **Shell commands:** wrapped per invocation with cross-agent policy (deny
   active agent-memory tree, carve current agent's own memory back out, leave
   repo/home/tmp writable, network open).
2. **Memory-mode subagents** (reflection, memory, init, history-analyzer):
   entire process wrapped. Reads broadly, writes restricted.
3. **In-process file tools** (Read/Edit/Write): cannot fork, so kernel sandbox
   can't see them. Old static cross-agent guard remains: resolves both lexical
   and realpaths to cover symlink escapes.

### Backends

- **Seatbelt (macOS):** `detectSandboxBackend()` must actually probe
  (`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`), not just check
  file existence. If probe fails, degrade to no-sandbox.
- **bwrap (Linux):** mount namespace, root `--bind / /` for cross-agent mode,
  `--ro-bind / /` for memory mode. Denied roots `--tmpfs` masked.
- **Windows:** C# helper with restricted tokens + temporary ACLs + kill-on-close
  Job Object. Uses `S-1-5-21-*` domain-shaped SIDs (NOT `S-1-15-3-*` capability
  SIDs which fail on standard Windows). `asInvoker` manifest to avoid UAC.

### Cross-Backend Policy

Sandbox policy must deny BOTH memory trees:
- API/cloud: `~/.letta/agents`
- Local backend: `$LETTA_LOCAL_BACKEND_DIR`/memfs

### Environment Variables

- `LETTA_FS_SANDBOX=0` , opt-out everywhere
- `LETTA_SANDBOX=<backend>` , sentinel inside sandboxed children

---

## Runtime Model Catalog

The model catalog is a dynamic runtime service, not a static `models.json` file.

**API mode (cloud):** loads from `GET /v1/models/catalog` at startup. If cloud
fails and no cache -> startup exits with error. If cache exists -> degraded mode.

**Local mode:** projects pi-ai model inventory into `CatalogModel` shape via
`toLocalCatalogModels()`. If pi-ai unavailable -> empty catalog, continues
normally.

Key files: `src/agent/model-catalog.ts`, `src/agent/remote-model-catalog.ts`,
`src/agent/available-models.ts`, `src/backend/local/local-model-config.ts`.

**Test fixture pattern:** The `models` array is shared mutable state across the
test suite. Use `setupRuntimeModelCatalogFixture()` (bundles setup + cleanup) from
`src/test-utils/runtime-model-catalog.ts`. All test files touching the model
catalog must use this fixture.

---

## Subagent Lifecycle & Reflection

### Subagent Lifecycle API

- `ctx.subagents.list()` , returns fuller lifecycle items (type, status,
  durationMs, agentId, visibleInTranscript). No `active` field (use `pending ||
  running`). No `surface` field (use JS `.filter()`). No filter sugar.
- `ctx.backgroundAgents` , slim projection (`type`, `status`, `durationMs`,
  `agentId`). Sufficient for minimal text-only rendering.
- Both read from the same source (`subagentLifecycleSnapshot` in `InputRich`).
  Difference is projection depth.
- Completed/error agents retained ~30s before cleanup. Consumers must filter on
  `status` if they only want active agents.

### Product-Status Panel

- `order: 1` = product-status replacement (singleton, newest-wins).
- Built-in default panel injected by `InputRich` when no user panel occupies
  `order: 1`.
- User mod at `order: 1` suppresses the built-in default.
- `ctx.link(label, url)` helper for OSC-8 hyperlinks. In tmux, OSC-8 doesn't
  work, default panel omits URL entirely.
- Spinner state is host-owned, fed to default panel via options. A user mod at
  `order: 1` runs its own `setInterval` + `panel.update()` to animate.

### Reflection Worktree

Harness manages the worktree lifecycle (not the reflection agent):
- State: `landed` (clean merge), `noop` (no commits), `retry` (dirty),
  `pending_integration(reason)` (merge failed, branch preserved).
- Reflection agent NEVER semantically resolves conflicts.
- Transcript marked consumed only when memory lands on main.
- Reflection settings are per-agent; trigger counter is per-conversation.
- Counter increments on completed assistant steps (not user messages, not tool
  calls, not interrupted turns).

---

## Cross-Platform Patterns

### Windows Symlinks

`fs.symlink(source, dest, "dir")` on Windows requires elevated privileges
(Developer Mode or admin). Use `"junction"` type on win32 instead, doesn't
require elevated privileges.

```ts
fs.symlink(target, dest, process.platform === "win32" ? "junction" : "dir")
```

### Windows-Specific

- `PATH` vs `Path` case sensitivity (Node uses `Path`).
- `node -e 'script'` quoting breaks, use a temp file.
- `/bin/sh` doesn't exist, don't use in fallback paths.
- Worktree path length: use shorter dirname (`"wt"` vs `"worktree"`) on Windows.
- `process.kill(pid, 0)` for stale lock detection works but behavior differs
  slightly.

### Turbopack Symlinked node_modules

In worktree setups where `node_modules` is symlinked, Turbopack rejects
symlinks pointing outside the project root. Replace with hard links:
`rm node_modules && cp -al <source_dir> ./node_modules`.

### next-env.d.ts Regeneration

`next-env.d.ts` gets regenerated during `next dev` with `.next/dev/types/`
paths. Revert before committing: `git restore next-env.d.ts`.

---

## Git Workflow Patterns

### Squash-Merge Stacked PR Conflicts

PRs use squash merge. When PR A is squash-merged, downstream PR B (stacked on A's
branch) gets auto-retargeted to main by GitHub, creating conflicts because the
commits B expected no longer exist.

**Fix:** `git rebase --onto origin/main <pr-a-base-commit> <pr-b-branch>` ,
replay only PR B's commits onto main, dropping PR A's now-redundant commit.

### Squash-Merge Rebase Trap

After a PR is squash-merged, a branch based on the old unsquashed commits will
have duplicate changes if you do a normal `git rebase origin/main`.

**Fix:** stash the diff (`git stash push -u`), reset to main
(`git reset --hard origin/main`), apply the stash (`git stash apply`), resolve
only the real PR conflicts.

### Stash-Rebase-Apply for Uncommitted Spikes

When a worktree branch has uncommitted spike changes and needs rebasing onto
fresh main:
1. `git stash push -u -m "spike: ..."`
2. `git fetch origin main && git rebase origin/main`
3. `git stash pop` (conflicts expected)
4. Resolve conflicts, `git restore --staged .` to unstage
5. `git stash drop` after clean apply

### bun.lock Churn

Running `bun install` in a worktree may add `"configVersion": 0` after
`"lockfileVersion": 1` because the local Bun version is newer. Scrub with
`git checkout main -- bun.lock` when the PR has no real package.json change.

### Git Rebase in Non-Interactive Contexts

`git rebase --continue` opens vim. Use `GIT_EDITOR=true git rebase --continue`
to accept the default message without opening an editor.

### GitHub Token Types

- `gho_` (OAuth): works for `gh` CLI API calls, NOT for `git push` over HTTPS.
- `github_pat_` (fine-grained PAT): works for `git push` but only for
  user-owned repos, NOT org repos unless org approves.
- `ghp_` (classic PAT): works for everything including `git push` to org repos.
  This is the right type for pushing to `letta-ai/letta-code`.
- Push URL: `git push https://<user>:<token>@github.com/<org>/<repo>.git <branch> --force`

### Letta API: `summary_search` not `summary`

`GET /v1/conversations?agent_id=X&summary_search=owner/repo/pr-N` , the param
is `summary_search`, NOT `summary`. The API silently ignores unknown query
params; using `summary` returns ALL conversations for the agent.

---

## Shared Remote Server (lettamate)

`/Users/lettamate/letta-code` is a shared remote macOS server. Multiple
agents/people share worktrees here.

1. **Never use someone else's git credentials.** Set `GIT_AUTHOR_NAME`,
   `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` explicitly
   when committing.
2. **Never commit directly on main.** Always work in worktrees.
3. **Use clearly-named worktrees** prefixed with `amelia-` (e.g.
   `.letta/worktrees/amelia-rebase-2184`).
4. **Check existing worktrees** before creating new ones.
5. **Secrets** available via `$SECRET_NAME` substitution at exec time (not
   persistent env vars): `GITHUB_TOKEN`, `LETTA_API_KEY`, `SLACK_BOT_TOKEN`,
   `SLACK_APP_TOKEN`.
6. **Pre-existing `gh` auth** is for `just-cameron`, do NOT use it.
7. **Fine-grained PATs don't work for org repos.** Use a classic PAT (`ghp_`
   prefix) with `repo` scope.

---

## Watcher & Automation Workflows

### Upstream Release Watchers

Claude, Codex, and pi-ai watchers run every 2 hours, detect upstream releases,
and create draft parity PRs when warranted.

- Each run uses `--new` for a fresh conversation (isolated runs, no state
  compounding).
- Selective upgrade policy: only upgrade when there's concrete Letta Code
  benefit, a consumed contract fix, or a specific risk avoidance. Default is
  `no_upgrade`.
- Slack notifications post to `#code-reviews` only for `pr_created` outcomes.
  One random owner selected per notification.

### CI Workflow Patterns

- **Typecheck in workflow prompts:** After making edits in the target repo, run
  `npx tsc --noEmit` before committing/pushing. Prevents pushing broken types.
- **Draft-gate skip false failure:** Jobs with `if: github.event.pull_request.draft
  == false` are marked as skipped (not failed) in draft mode. Downstream
  `needs:` gates with `if: always()` treat skipped as non-success, causing false
  failures. Fix: check `needs.draft-gate.result == 'success' || needs.draft-gate.result
  == 'skipped'`.
- **Action ref caching:** GitHub Actions resolves branch refs to SHAs at trigger
  time and caches. Pushing new commits to the action branch doesn't update
  already-triggered runs. Pin to a specific SHA instead of `@main`.

### Review Workflow

- `review.yml` runs on ALL non-draft PRs (not just Caren's).
- Silent by default: only posts inline review comments when flagging issues.
- Final response: `LGTM` or `Left comments`.
- Conversation persistence via `summary_search` API lookup.
- Review prompt (~600 tokens) is re-sent on each run (intentional: compaction
  can evict old instructions).
- Compact prompt for re-reviews (existing conversation detected).
- Background agent gets stuck on complex reviews requiring repo setup + extensive
  reading. Do those in the foreground.

### Secret Injection Syntax

The harness only supports literal `$NAME` references for secret injection:
- `$AMELIA_GITHUB_TOKEN` injected
- `${AMELIA_GITHUB_TOKEN}` not expanded
- `${AMELIA_GITHUB_TOKEN:?}` not supported

### Repositories API Write Gotcha

`POST /v1/repositories/{id}/files` may return HTTP 500 after successfully
committing. Safe pattern: attempt write, if non-2xx, read back with
`GET /files/content?path=...`, compare `content_sha256` to local SHA-256, treat
as success if hashes match.

---

## Cloud & Teleport

### Cloud Environment Bridge

Cloud API teleport uses a 409 `TELEPORT_SOURCE_NOT_ACTIVE` error when the source
environment is not active. Rulesets (not branch protection) govern the cloud
side. CODEOWNERS: the author of a PR can't self-satisfy their own review
requirement.

### Desktop Device Selection

`pickDesktopLocalConnection` selects the desktop local connection for device
routing. Phantom "Interrupted" banners can appear from stale device selection
state.

### Dual-Listener Heartbeat Oscillation

When desktop runs both a local and cloud listener, heartbeat oscillation can
occur. Version compatibility between desktop and CLI must be maintained.

### Release Cascade

Automated cross-repository release orchestration publishes Agent SDK and ACP to
follow every stable Letta Code release. Not Dependabot, it needs multi-step
package releases in lockstep. Currently blocked by token permissions
(`amelia-letta` has read-only access to downstream repos).
