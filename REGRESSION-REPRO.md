# Queued turn completion regression reproduction

Origin: https://github.com/letta-ai/letta-code/pull/5327

Requested by: @cpacker

These are investigation probes, not a proposed production fix. They use the real
listener input router and queue, a stub turn callback, and the published Agent SDK
0.6.3 coordinator. No service credentials or model calls are required.

## Run

```sh
mkdir -p /tmp/letta-sdk-063
curl -fsSL https://registry.npmjs.org/@letta-ai/letta-agent-sdk/-/letta-agent-sdk-0.6.3.tgz | tar -xz -C /tmp/letta-sdk-063
LETTA_CONFIG_DIR=$(mktemp -d) LETTA_DEBUG=0 bun repro-queued-idle.ts /tmp/letta-sdk-063/package/src/remote-turn-coordinator.ts
LETTA_DEBUG=0 bun repro-signal.ts
```

Use a fresh LETTA_CONFIG_DIR for each run to isolate the durable input ledger.
Copy the same probes into a checkout of `85851b8a^` to compare. Install the
repository dependencies in each checkout or share node_modules.

## Listener result

On `85851b8a^`, the input acknowledgement says `started` and the callback logs
`client already finished= false`. There is no SDK result from the stub callback.

On `85851b8a` and `v0.34.29`, the acknowledgement says `queued`. The real queue
emits the following before entering the stub callback:

1. `stream_delta` with `message_type: user_message`.
2. `update_loop_status` with `status: WAITING_ON_INPUT`, `active_run_ids: []`.
3. The SDK completes successfully, without model or tool evidence.

The callback logs `client already finished= true`. A representative local SDK
result is `{"type":"result","success":true,"durationMs":41,"conversationId":"conv-repro"}`.

The acknowledgement itself is correctly `queued`; it does not say completed.
The SDK infers completion from the echo followed by the idle status. The server
can subsequently execute the turn, but the caller has already stopped collecting
it. A later request can receive output belonging to the earlier turn.

Evidence at `v0.34.29`:

- `src/websocket/listener/input-frame-router.ts:268-343`: content is always
  queued; lines 307-310 commit the queued disposition and 330-342 schedule and
  acknowledge it. #5327 removed the idle direct-dispatch branch.
- `src/websocket/listener/queue.ts:578-609`: emit the user echo and boundary
  status before calling the turn processor.
- `src/websocket/listener/protocol-outbound.ts:283-333`: an idle runtime projects
  WAITING_ON_INPUT with no active run IDs.
- SDK 0.6.3 `src/remote-turn-coordinator.ts:140-146`: every stream delta,
  including user echoes, marks observedTurnEvidence.
- SDK 0.6.3 `src/remote-turn-coordinator.ts:293-298`: WAITING_ON_INPUT plus that
  evidence completes the request.

This explains instant successful turns, an empty tool-return collection when a
consumer returns on the first result, persistence checks before tools settle,
and replies from a previous request being collected for a later request.

## Shell result

The probes produce identical results immediately before #5350 and on current
main (`e43d5d372`):

- A raw SIGKILL returns `exitCode: null` and empty raw pipes. The runner has no
  signal field; this is pre-existing behavior.
- A killed Bash child returns an error containing `Exit code: 137` and `Killed`.
- A killed Bash launcher returns an error containing
  `Terminated by signal before exiting`.
- Calling the process handle's SIGKILL preserves `buffered-before-kill` output.

Bash formats null exit codes at `src/tools/impl/bash.ts:502-520`. #5350's new
100 ms timer only activates when the handle's kill method records a forced kill
(`src/tools/impl/shell-runner.ts:225-247`). An external OOM kill on POSIX does not
set that flag. These probes do not create memory pressure or reproduce cgroup
OOM behavior; they do exercise SIGKILL completion and Bash result formatting.

The same probes were also bundled with Bun for Node and executed successfully
under Node. No #5350 regression was found and no production change is proposed.

## Verification

- `bun run check`: all 13 checks pass.
- `bun test src/tools/impl/shell-runner.test.ts src/websocket/listener/message-router-pending-dispatch.test.ts src/websocket/listener/steering-drain.test.ts`: 18 pass.
- `bun test src/tools/bash.test.ts`: 23 pass.
- `bun test src/websocket/listener/queue-boundary-status.test.ts src/websocket/listener/input-admission.test.ts src/websocket/listener/inbound-dispatch.test.ts src/websocket/listener/external-tool-reconnect.test.ts`: 29 pass.

Managed sandbox end-to-end tests were not rerun. The listener probe stubs the
turn body; it proves client completion before execution, not backend execution
or persistence. The shell probes use real subprocesses.
