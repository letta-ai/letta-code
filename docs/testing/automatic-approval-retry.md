# Automatic-denial retry regressions

This follow-up builds on the [busy-run recovery](busy-recovery.md) from #5232.
It checks approval validity after the blocking run finishes. It does not identify
who submitted the first result in the historical incident.

## Run the focused regressions

From the repository root, with dependencies installed:

```sh
bun test src/agent/automatic-approval-retry.test.ts src/cli/app/approval-retry-input.test.ts src/cli/app/AutomaticApprovalRetry.test.tsx src/websocket/listener/send-automatic-approval.test.ts
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

## Recorded validation before upstream integration

On Windows with Bun 1.3.11 and Node 22.19.0, before integrating newer upstream commits:

- Final focused run: 274 tests passed across 16 files; no failures.
- `bun run check`: all 13 stages passed, including TypeScript and Biome.
- `bun run build` and `node letta.js --version`: passed; the bundle reported
  `0.34.21 (Letta Code)`.
- Six Node-target TUI scenarios passed: normal, changed pending calls, unchanged
  pending calls, consumed denials, failed pending-state read, and SSE-only errors.
- Focused instrumentation reported full line/function coverage for the two new
  policy and text-restoration modules. This is not a global coverage claim.

The original TUI RED run had one passing control and three failing recovery
cases. The SSE-only case failed separately before its classifier fix. Review
also caught and corrected a malformed-content regression in text restoration.

## Limits

This is synthetic, focused evidence, not a successful full-repository suite or
a live production concurrency test. The pending-state check is not an atomic
backend transaction, so the existing server-conflict recovery remains necessary.
Historical sender attribution still requires server-side correlation. No
independent coding-agent review or human verification is claimed here.
