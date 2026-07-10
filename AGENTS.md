# letta-code — Agent Guide

This file explains how to work effectively in this repo. It covers the rules enforced by CI, **why each rule exists**, and the workflow conventions that keep the codebase healthy and agent-navigable.

---

## Workflow

1. **Create a worktree** for any non-trivial change — especially if another agent may be working concurrently.
2. **Make your change**, then run `bun run check` and fix all failures before opening a PR.
3. **Do not commit or push** until explicitly asked to. Caren will say when she's ready.
4. **One PR per logical change.** Don't bundle unrelated changes — harder to revert if something breaks.
5. **Never amend commits.** Always create a new commit.
6. **Check the current branch** before editing files. If in doubt, ask.

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
- If a test file must use `mock.module()`, run it as a standalone `bun test` invocation separate from the main worker pool (see `scripts/run-unit-tests.cjs` for the pattern).
- If a test passes alone but fails in `bun test src/`, suspect mock leakage first.

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

### Known Gotchas

- **`react-dom` is not installed.** Ink does not use it. Do not import `unstable_batchedUpdates` or anything else from `react-dom`.
- **Prettier is not used.** Biome is the sole formatter. Do not add Prettier — they conflict.
- **Ink uses legacy React mode (mode 0).** React 18 automatic batching does not apply in async contexts. Move state updates before any `await` to batch them naturally.
- **`<Static>` items never re-render.** Once committed to `staticItems`, a Ink `<Static>` item's props are frozen. Force a re-render by changing the `<Static key>` prop — but only key on values that change infrequently (not every tool call).
- **`new URL("./path.ts", import.meta.url)` in tests** is not a static import and is not caught by the `@/` import codemod. Scan for `new URL(` manually when moving source files.
- **grep exits 1 on no matches** — pre-commit hooks use `|| true` on grep pipes to prevent false failures on clean commits.
- **macOS case-insensitive FS** — `existsSync("bash.ts")` returns `true` when `Bash.ts` exists. Rename scripts that use `existsSync` to check kebab-case targets will silently skip single-word PascalCase files. Use `git mv` for renames.
