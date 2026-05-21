# letta-code — Agent Guide

Quick reference for agents working in this repo. Covers toolchain, conventions, layer rules, and CI.

---

## Toolchain

This project uses **Bun**, not Node/npm/pnpm.

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Run script | `bun run <script>` |
| Run file | `bun <file>` |
| Run tests | `bun test` |
| Full check suite | `bun run check` (7 checks — see below) |
| Dev server | `bun run dev` |
| Type check only | `bun run typecheck` |
| Lint + format | `bun run lint` |

Do not use `node`, `ts-node`, `npm`, `yarn`, `pnpm`, `jest`, or `vitest`.

---

## Check Suite

`bun run check` runs 7 checks in order. All must pass before a PR is ready:

1. **relative-imports** — no `../` parent imports in staged `.ts/.tsx` files (use `@/` instead)
2. **cycles** — zero circular dependencies (madge)
3. **boundaries** — no cross-layer imports (see Layer Map below)
4. **exported-functions** — exported functions use `export function`, not `export const fn = () =>`
5. **test-mock-isolation** — no `mock.module()` calls outside designated isolation patterns
6. **biome** — format + lint (964 files)
7. **typescript** — `tsc --noEmit` with strict flags including `noUnusedLocals` / `noUnusedParameters`

The pre-commit hook (husky) runs the same checks on every commit, in the same order. Fix failures before committing — don't use `--no-verify`.

---

## Import Conventions

**Always use the `@/` alias** for cross-directory imports. `@/` maps to `src/`.

```ts
// correct
import { getBackend } from "@/backend";
import { isDebugEnabled } from "@/utils/debug";

// wrong — relative parent imports are banned and blocked by pre-commit
import { getBackend } from "../../backend";
```

**Four files are exempt** from the ban (they legitimately live above `src/`):
`src/version.ts`, `src/index.ts`, `src/cli/cli.ts`, `src/cli/app/App.tsx`

Within the same directory, `./` relative imports are fine.

---

## Filename Conventions

| File type | Convention | Example |
|-----------|-----------|---------|
| `.ts` source | kebab-case | `local-store.ts`, `agent-id.ts` |
| `.tsx` components | PascalCase | `AgentSelector.tsx`, `InputRich.tsx` |
| `.test.ts` | same as source | `local-store.test.ts` |
| `index.ts` | always `index.ts` | barrel re-exports only, no logic |

Enforcement: `scripts/check-filename-casing.js` runs in pre-commit and CI.

---

## Export Conventions

Use **named exports** everywhere. Default exports are banned (`style/noDefaultExport` biome rule).

Use `export function` for functions, not `export const fn = () =>`:

```ts
// correct
export function computeThing(x: string): number { ... }

// wrong — flagged by scripts/check-exported-functions.js
export const computeThing = (x: string): number => { ... }
```

Exception: `.tsx` files using `React.memo()` may use `export const`.

---

## Layer Map

Files must only import from the same layer or layers **below** them. No upward imports.

```
cli/           ← top: Ink UI, commands, overlays
websocket/     ← WS listener, session management
agent/         ← domain: conversation, approval, context
tools/         ← tool implementations
backend/       ← API/storage abstraction (getBackend, LocalStore, APIBackend)
providers/     ← LLM adapters (Anthropic, OpenAI wrappers)
permissions/   ← pure permission rules
telemetry/     ← leaf: observability (may call backend/api/ only)
cron/          ← leaf: scheduler
channels/      ← leaf: channel integrations
utils/         ← bottom: no domain deps
```

**Enforced rules** (violations block CI):
- `tools/` cannot import from `cli/`
- `backend/` cannot import from `cli/` or `websocket/`
- `providers/` cannot import from `agent/` or `cli/`
- `websocket/listener/` cannot import `backend/api/client` or `backend/api/conversations` directly
- `cli/app/` cannot import `backend/api/conversations` directly

When adding a new file, put it in the lowest layer that satisfies its dependencies.

---

## Testing

Tests live **next to their source files** (colocated), not in a separate `tests/` directory.

```
src/backend/local/local-store.ts
src/backend/local/local-store.test.ts   ← colocated
```

Shared test utilities go in `src/test-utils/`.

Run a specific test file:
```sh
bun test src/backend/local/local-store.test.ts
```

Run all unit tests (excludes integration tests):
```sh
bun test $(find src -name "*.test.ts" | grep -v integration-tests)
```

### Bun Module Mocking

`mock.module()` is **process-global** in Bun — mocks leak across test files sharing the same worker. Rules:

- Don't mock broad shared modules (`settings-manager`, telemetry, etc.) unless there's no better seam.
- Prefer test seams, object-level stubbing, or dependency injection over `mock.module()`.
- If you must use `mock.module()`, restore in teardown.
- If a test passes in isolation but fails in the full suite, suspect mock leakage first.
- For tests that require strict isolation from a mocking test file, run them as a separate `bun test` invocation (see `scripts/run-unit-tests.cjs`).

---

## TypeScript

Strict flags enabled in `tsconfig.json`:

- `noUnusedLocals` / `noUnusedParameters` — unused variables are errors. Use `_prefix` for intentionally unused params; use `void x` to discard a value.
- `noImplicitReturns` — all code paths must return.
- `strict: true` — includes `strictNullChecks`, `noImplicitAny`, etc.

`tsc --noEmit` runs on every commit and every CI run. TypeScript errors cannot be committed.

---

## Pre-commit Hook Gotchas

- **grep exits 1 on no matches** — hooks use `|| true` on grep pipes to avoid false failures on clean commits.
- **lint-staged v16 exits 1 on empty staged set** — the hook guards with a file-count check before calling lint-staged.
- **Relative import check runs first** — so its clear error appears before `tsc` fires confusing `TS2307`s.
- **`new URL("./path.ts", import.meta.url)` in tests** — these are NOT caught by the `@/` import codemod; scan for `new URL(` manually when moving files.

---

## Biome

Biome is the sole formatter and linter. Do not add Prettier — they conflict.

Suppress a specific rule for one line:
```ts
// biome-ignore lint/style/noNonNullAssertion: value is guarded by expect().toBeDefined() above
const result = value!.data;
```

`bun run fix` auto-fixes biome violations (format + lint autofixes only). Circular deps, boundary violations, exported-function style, and TypeScript errors require manual fixes.

---

## Environment

- `LETTA_DEBUG=1` — enables verbose debug output. `bun run dev` sets this by default; use `LETTA_DEBUG=0 bun run dev` to suppress.
- `LETTA_LOCAL_BACKEND_EXPERIMENTAL=1` — enables local (in-process) backend mode.
- `LETTA_LOCAL_BACKEND_EXECUTOR=deterministic` — uses deterministic fake executor (tests).
- `react-dom` is **not installed** — Ink does not use it. Do not import from `react-dom`.
