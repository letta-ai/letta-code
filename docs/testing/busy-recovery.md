# Reproduce busy-run recovery without a Letta account

This is the test-only reproducer for #5232. It mounts the real
`useConversationLoop` against a synthetic backend: no account, API key, private
transcript, or real tool execution. The later approval-state check is a separate
change in [#5240](https://github.com/letta-ai/letta-code/pull/5240).

## Setup

Use Node 22.19 or newer and Bun. Check `node --version`,
`node -p "process.execPath"`, and `bun --version` first. On Windows, select one
Node installation and avoid duplicate `PATH`/`Path` entries in the launching shell.
Use a disposable clone so switching revisions cannot overwrite local work:

```sh
git clone --branch fix/approval-resume-investigation https://github.com/JoaoMarcos44/letta-code.git busy-recovery
cd busy-recovery
```

Record the corrected SHA and retain a copy of the helper before switching to
the failing baseline. The helper does not exist at that baseline.

POSIX shell:

```sh
CORRECTED=$(git rev-parse HEAD)
printf '%s\n' "$CORRECTED"
export CI=true
mkdir -p .letta/busy-repro
cp scripts/verify-busy-recovery.cjs .letta/busy-repro/verify.cjs
```

PowerShell:

```powershell
$CORRECTED = git rev-parse HEAD
$CORRECTED
$env:CI = 'true'
New-Item -ItemType Directory -Force .letta/busy-repro
Copy-Item scripts/verify-busy-recovery.cjs .letta/busy-repro/verify.cjs
```

## Compare baseline and fix

Run from the clone root. Dependencies are unchanged between these revisions;
install once. Run commands individually and inspect their exit codes
(`$LASTEXITCODE` on PowerShell), especially the intentional failures below.

```sh
bun install --frozen-lockfile
node --test scripts/verify-busy-recovery.test.cjs

git switch --detach f5447302
bun test src/cli/app/BusyRunRetry.test.tsx
# EXPECT: exit 1; one passing control and two failing recovery cases.
node .letta/busy-repro/verify.cjs --expect broken
# EXPECT: exit 0; only the specific baseline observations satisfy "broken".
node .letta/busy-repro/verify.cjs --expect fixed
# EXPECT: exit 1; baseline must not satisfy the fixed contract.

git switch --detach "$CORRECTED"
bun test src/cli/app/BusyRunRetry.test.tsx
# EXPECT: exit 0; all three cases pass.
node .letta/busy-repro/verify.cjs --expect fixed
# EXPECT: exit 0.
```

## Contracts and isolation

| Scenario | Corrected behavior | Baseline observation |
| --- | --- | --- |
| normal | One POST, one accepted original payload, `end_turn`, no UI errors | Same control passes |
| busy | Original text and OTID accepted once; blocker polled until the virtual clock reaches 90 seconds; `end_turn`, no errors | No accepted payload or polls; stops at 70 seconds without `end_turn` |
| accepted-own-otid | One POST; resume only its own OTID; one accepted original payload; `end_turn`, no errors | Payload accepted, but no `end_turn` |

The helper bundles the tracked TUI fixture with Bun, then runs it with
`process.execPath` (Node). A virtual clock avoids real 90-second sleeps.
Each child has a 60-second wall-clock limit. Crashes, timeouts, missing markers,
invalid JSON, and wrong scenarios are infrastructure failures, not valid REDs.
The generated bundle remains in ignored `.letta/busy-repro/scenario.mjs`.

Children receive an allowlisted OS environment, not inherited credentials or
`NODE_OPTIONS`/`BUN_OPTIONS`. Telemetry and mods are disabled; the fixture uses
a temporary home and a throwing `fetch` guard. This is test isolation, not an
OS-wide network sandbox. The helper does not install dependencies, switch
revisions, or install the global CLI.

## Limits

This fixture covers the TUI; headless, listener, and helper regressions remain
separate tests. The shared wait has a finite budget per wait, not a global
five-minute deadline. Unknown metadata is not proof that a run finished.
These synthetic checks do not establish a green full-repository suite,
production concurrency safety, or the sender of the historical approval result.
