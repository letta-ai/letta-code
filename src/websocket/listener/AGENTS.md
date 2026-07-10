# Listener State Machine Guide

This directory owns local listener orchestration. Read this file before changing
turns, approvals, cancellation, recovery, queue gating, or status projection.

## Canonical Ownership

`TurnLifecycle` in `turn-lifecycle.ts` is the only owner of active-turn state.
`ConversationRuntime` exposes read-only projections for compatibility:

- `isProcessing`
- `cancelRequested`
- `loopStatus`
- `activeWorkingDirectory`
- `activeRunId`
- `lastStopReason`

Never add setters or parallel flags for these values. Add a lifecycle transition
when a new state is genuinely required.

The lifecycle states are complete and mutually exclusive:

- `idle`: no local owner; queue work may start.
- `command`: a synchronous command owns the conversation.
- `active`: a message or approval-recovery turn owns the conversation.
- `cancelling`: the active lease was aborted; UI projects idle, but the queue
  remains blocked until that lease settles.

## Lease Rule

Every active turn has a `TurnLease`. Async state changes and side effects must
carry that exact lease. Never look up `currentLease` after an await and assume
it still belongs to the caller. Check `isCurrent(lease)` immediately after
awaited execution boundaries, before mutating runtime state or emitting tool,
protocol, file, or channel events. Capture run IDs and other turn-local context
before the await; do not read them from a replacement runtime afterward. A
current cancelling lease may emit normalized interrupt results. A stale lease
must emit nothing.

`clearConversationRuntimeState()` is an authoritative local reset. It aborts and
invalidates the current lease, returns the lifecycle to `idle`, and clears
conversation-scoped transient state. Code unwinding after reset must treat its
lease as stale and must not repopulate state.

Explicit `abort_message` is different: it calls `requestCancellation()`, which
moves `active -> cancelling`. The turn owner later completes
`cancelling -> idle`. Do not clear cancellation because a late approval response
arrived.

## Terminal Rule

The enclosing turn owner finalizes every lease exactly once through
`finishListenerTurn()`. Terminal helpers may prepare an outcome, but they must
not silently finalize shared runtime state.

Use discriminated results:

- Approval branch: `continue | interrupted | terminal | error`
- Approval send: `stream | terminal`

Do not reintroduce `terminated: boolean`, sentinel `null`, or a result whose
caller must guess whether another layer already finalized the turn.

`requires_approval` is a continuation boundary, not a terminal turn. A pending
approval remains inside the same active lease.

## Queue And Status

Queue gating consumes `turnLifecycle.snapshot()`. It must not reconstruct
activity from a boolean chain. Protocol device/loop status reads the read-only
runtime projections derived from that same lifecycle.

Do not add queue self-healing as the primary fix for an impossible state. Find
and repair the transition that produced the state. Defensive telemetry is fine
after the producer path has a regression test.

## Module Map

- `turn-lifecycle.ts`: canonical state, leases, and transitions.
- `turn.ts`: one-turn orchestration and the stream stop-reason loop.
- `turn-setup.ts`: input normalization, reminders, mod start, and tool context.
- `turn-send.ts`: initial/retry send selection and recovered terminal results.
- `turn-approval.ts`: live approval execution and continuation branching.
- `turn-events.ts`: mod lifecycle events and reflection launch wiring.
- `turn-completion.ts`: successful turn-end persistence and reflection work.
- `turn-terminal.ts`: exact-once terminal projection.
- `turn-status.ts`: loop-status transitions and emission.
- `turn-cleanup.ts`: post-terminal persistence and memory sync.
- `turn-context.ts`: guarded process-context ownership release.
- `turn-transcript.ts`: pure inbound transcript/telemetry helpers.
- `recovery.ts`: stale and process-restart approval recovery.
- `queue.ts`: queue ingestion and lifecycle-snapshot gating.
- `inbound-dispatch.ts`: serialized direct-message ownership handoff.
- `inbound-queue.ts`: lossless inbound-message queue registration.

## Investigation Checklist

When logs show contradictory state:

1. Separate what logs prove from the proposed event sequence.
2. Trace the owner that acquired the lease and every return/catch/finally that
   can release it.
3. Search every lifecycle transition and inspect `git blame` plus `git log -S`
   when adjacent code assumes different contracts.
4. Reproduce the production transition sequence. Do not begin a regression test
   by manually constructing the impossible aftermath.
5. Verify the test fails on the buggy base and passes because the producer was
   fixed, without relying on queue self-healing.

## Test Ownership

- `turn-lifecycle.test.ts`: pure transition table, exact-once, stale leases.
- `turn-lifecycle-integration.test.ts`: cross-module producer regressions.
- `approval.test.ts`: approval wait/resolution/cancellation ownership.
- `recovery-lease.test.ts`: recovered approval await/lease boundaries.
- `message-router.test.ts`: direct-message ownership handoff and queue drain.
- `listener-queue-adapter.test.ts`: queue decisions from valid snapshots.
- `channel-turn-session.test.ts`: channel progress lifecycle fan-out.

Keep new tests next to their owner and below 1,000 lines. Do not grow the legacy
protocol/concurrency test monoliths; move focused coverage here instead.
