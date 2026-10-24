# Reproduce busy-run recovery without a Letta account

This is the test-only reproducer for #5232. It mounts the real
`useConversationLoop` against a synthetic backend: no account, API key, private
transcript, or real tool execution. It also covers the review's queue-failure
and foreign-approval ownership cases. Revalidation of stale automatic-denial
batches remains separate work in [#5240](https://github.com/letta-ai/letta-code/pull/5240).

## Setup

Use a Node version supported by `package.json` (verified with 22.23.4) and Bun. Check `node --version`,
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
# EXPECT: exit 0; original scenarios and review regressions pass.
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

## Review regression evidence

The additional journeys come from [review 5635646017](https://github.com/letta-ai/letta-code/pull/5232#pullrequestreview-5635646017):
keep rejected input and later queued items on failure, retain foreign approval
ownership, and make the listener tests pass independently of #5240.

```sh
bun test src/cli/app/BusyRunRetry.test.tsx src/cli/app/busy-input-approval-guard.test.ts src/cli/helpers/tui-busy-input.test.ts src/cli/helpers/tui-queue-input.test.ts src/queue/queue-runtime.test.ts src/cli/helpers/tui-turn-lifecycle.test.ts
# Run these in separate processes to keep module mocks isolated:
bun test src/agent/busy-request-resume.test.ts
bun test src/agent/busy-run-wait.test.ts
bun test src/headless-busy-run.test.ts
bun test src/websocket/listener/send-busy-run.test.ts
bun test src/websocket/listen-client-concurrency.test.ts
bun run check
```

| Guarantee | Regression / evidence |
| --- | --- |
| Deadline, retry exhaustion and unavailable blocker metadata preserve the original payload followed by later inputs | `queue-timeout`, `queue-exhausted`, `queue-metadata-failure`: all three lost the complete queue before integration; now preserve content, OTID, FIFO and an explicit-resume boundary |
| A foreign approval wait cannot auto-deny or rotate the rejected OTID | `foreign-approval`: failed before the guard; now follows a continuation blocker and admits byte-equivalent input, without reading approvals |
| Foreign approval timeout preserves ownership even after manual resume | `queue-approval-timeout`: originally cleared the queue; now parks, resumes without submit-hook rebuilding, and never reads foreign approvals |
| Cancellation cannot send or deny while waiting for another client's approval | `cancel-foreign-approval`: aborts the wait with no accepted input or approval reads |
| An accepted own request is not put back in the retry queue after transport failure | `queue-own-drain-error`: one POST and one accepted payload, with only later inputs parked |
| A late notification cannot bypass parked input | `tui-busy-input.test.ts`: previously had one ready item after parking; now zero until resume |
| Listener polling is accelerated without reducing the cancellation deadline to zero | Both reported blocking-run tests failed before the timer fix; the complete concurrency test file now passes |

The original Node verifier still checks its three baseline-compatible scenarios.
After it builds `.letta/busy-repro/scenario.mjs`, each review scenario above can
also be run with `node .letta/busy-repro/scenario.mjs <scenario>`. Inspect its
`TUI_BUSY_RESULT` for the payload, queue, admission and cancellation contracts;
expected recovery failures appear in `errors` and are not a fixture crash.
The seven review scenarios were additionally checked under Node 22.23.4 for
payload equality, queue retention, admission count and zero foreign approval reads.
The final focused run passed 154 tests: 80 TUI/queue/lifecycle tests plus 74
isolated helper/headless/listener tests. All 13 repository checks passed, as did
the seven verifier unit tests and its three baseline-compatible Node scenarios.

Focused coverage measures the new approval guard and retry-envelope helper at
100% lines, the queue dispatch helper above 95%, and `QueueRuntime` at 100%.
This is not whole-application coverage: imported dependencies and the child
hook fixtures are not a combined end-to-end coverage denominator. The hook
tests do not claim a live multi-client backend or a full keyboard-driven App UI test.
