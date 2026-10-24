# Automatic-denial retry regressions

This follow-up builds on the [busy-run recovery](busy-recovery.md) from #5232.
It checks approval validity after the blocking run finishes. It does not identify
who submitted the first result in the historical incident.

## Run the focused regressions

From the repository root, with dependencies installed:

```sh
bun test src/agent/automatic-approval-retry.test.ts src/agent/automatic-approval-read.test.ts src/agent/check-approval-read.test.ts src/backend/api-resume-tail.test.ts src/cli/app/system-reminders.test.ts
bun test src/cli/app/AutomaticApprovalRetry.test.tsx src/cli/app/BusyRunRetry.test.tsx
# Run listener/module-mock suites in separate processes:
bun test src/websocket/listener/send-automatic-approval.test.ts
bun test src/websocket/listen-client-concurrency.test.ts
bun test src/headless-busy-run.test.ts
bun run check
```

The TUI test mounts the real conversation hook against a synthetic backend. The
listener tests exercise both send paths. These cases do not execute real tools
or submit production approvals.

## Contracts

- A valid automatic-denial batch retains its message objects and OTIDs.
- A changed pending set is not replaced with fresh automatic decisions. The TUI
  shows the current approvals; noninteractive retry paths stop safely.
- When all automatic denials have been consumed, only their envelopes are
  removed. Unsent user-message objects remain intact. An empty request is never
  submitted.
- Real tool results and user decisions are not discarded or rewritten by the
  retry reconciler. A stale mixed batch stops rather than replaying tools.
- A failed pending-state read, including a missing in-context message, does not
  count as proof that the approvals were consumed.
- Cancellation and lost listener ownership prevent another submission after
  an awaited read.
- The TUI also classifies retained SSE errors when run-error metadata is absent.
- Restored user text excludes injected reminder parts. Malformed runtime parts
  are ignored without losing valid text.

Validation snapshots belong in [PR #5240](https://github.com/letta-ai/letta-code/pull/5240).
The contracts above remain the acceptance criteria when rerunning the tests.

## Limits

This is synthetic, focused evidence, not a successful full-repository suite or
a live production concurrency test. The pending-state check is not an atomic
backend transaction, so the existing server-conflict recovery remains necessary.
Historical sender attribution still requires server-side correlation. No
human verification of the AI-assisted review follow-up is claimed here.

## Review follow-up

The review on #5240 identified two read failures and a conflict with #5236.
This follow-up is rebased on #5232 at `1f2bb90c`, which already contains current
`main`, the listener timer correction, lossless queue recovery and foreign-approval
ownership protection. Do not replay the old #5232 commits on top of it.

| Review guarantee | Evidence |
| --- | --- |
| Cancellation promptly releases a stalled agent, conversation, message or history read | `automatic-approval-read.test.ts`: all four stages stayed pending before the fix and now reject with the original cancellation reason, even if the backend never settles |
| Pending-state reads have their own deadline | A 30-second total read budget covers agent retrieval and approval lookup together, separate from blocker waiting; the short injected-deadline test reproduced the missing bound |
| Cancellation reaches the actual SDK request | `api-resume-tail.test.ts`: named/default history and agent reads initially lost the signal; agent query parameters and third-argument request options are now distinct |
| Late reads cannot authorize retry or start another request | The deadline test resolves the stalled agent lookup late and verifies no subsequent message lookup |
| A strict default-conversation history failure is not evidence of no approvals | `check-approval-read.test.ts`: missing in-context IDs plus failed history originally returned empty approvals; strict mode now rejects, while non-strict interactive resume retains its fallback |
| Aborted history reads cannot initiate another metadata read | The named-conversation test reproduced a fallback after cancellation and now verifies zero further reads |
| #5236's matching local results and plain-message retry remain intact | `turn-recovery-policy.test.ts` retains the matching-result contract; `AutomaticApprovalRetry.test.tsx` exercises empty pending state after both pre-stream invalid-ID rejection and SSE error |
| Queue recovery and composer restoration do not duplicate unsent input | The combined hook test originally left the text in both places after a failed reconciliation; now only the original rich payload remains in the parked queue |
| Reuse the restoration helper from main | The duplicate `approval-retry-input` helper was removed. Its malformed-runtime guarantee is tested on `getRestorableUserText` alongside main's existing reminder/whitespace contract |

The shared read removes its timer and abort listeners on every exit, passes
the captured signal through the backend and disables SDK retries on these reads.
Changing or consuming approvals still does not authorize replay of real results.
The shared approval-context parsing was extracted without changing its fallback,
and the loop file shrank rather than raising its file-size baseline.

The hook fixture also provides `approval-cancel-read`, `approval-empty-prestream`
and `approval-empty-sse` for the Node bundle created by
`node scripts/verify-busy-recovery.cjs --expect fixed`. Run additional scenarios
as `node .letta/busy-repro/scenario.mjs <scenario>` and inspect `TUI_BUSY_RESULT`.

### Local verification snapshot

- 333 distinct focused tests passed across 22 files, in isolated/serialized runs:
  37 read/reconciliation/helper tests, 18 real-hook TUI journeys, and 278 existing
  backend, approval-policy, headless, listener, queue and lifecycle regressions.
- All 13 repository checks passed on the final code, including TypeScript,
  Biome, dependency cycles, boundaries, mock isolation and file-size ratchets.
- The tracked Node verifier passed its three baseline-compatible scenarios under
  Node 22.23.4. All eight approval-specific hook scenarios also passed under that
  runtime, including the stalled-read cancellation and both empty-pending paths.
- Focused LCOV reports 101/101 lines for `automatic-approval-retry.ts`, 65/65 for
  the recovery guard/context helper, and 35/35 for `system-reminders.ts`. This is
  focused helper coverage, not a combined whole-application coverage claim.
- A separate read-only agent review found no actionable defect in the
  cancellation/rebase diff. Its review did not substitute for executing tests.

The broader regression selection also includes `check-approval.test.ts`,
`check-approval-resume-data.test.ts`, `check-approval-prepare-message.test.ts`,
`turn-recovery-policy.test.ts`, `api-backend.test.ts`,
`headless-approval-recovery.test.ts`, both listener send suites and the
TUI queue/lifecycle suites. Run the module-mocked files in their own processes.
