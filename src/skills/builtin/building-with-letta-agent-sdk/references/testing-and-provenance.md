# Testing and provenance contract

Use this contract for every Agent SDK system. The goal is to make runtime
behavior reconstructible without leaking private context.

## Contents

- Expectation-first tests
- Run manifest
- Event log
- Effect receipts
- Test matrix
- Retry and recovery
- Feedback categories

## Expectation-first tests

Before a live run, state:

```text
Given <initial durable state>
When <one SDK action occurs>
Then <observable SDK events appear>
And <external effect receipt proves the product result>
And <cleanup leaves the declared final state>
```

A transcript is not an effect receipt. An assistant saying it updated a ticket
does not prove the ticket changed.

## Run manifest

Persist a sanitized manifest for important runs:

```json
{
  "schemaVersion": 1,
  "runId": "job-123:attempt-1",
  "startedAt": "2026-07-31T00:00:00Z",
  "sdk": {
    "package": "@letta-ai/letta-agent-sdk",
    "version": "0.0.0",
    "backend": "local"
  },
  "runtime": {
    "agentId": "agent-...",
    "conversationId": "conv-...",
    "sessionId": "session-...",
    "environmentSelector": "sanitized-stable-id"
  },
  "request": {
    "idempotencyKey": "job-123",
    "inputSha256": "...",
    "resourceRefs": ["repo-id@commit"]
  },
  "policy": {
    "permissionMode": "standard",
    "allowedTools": ["lookup_ticket", "Read"]
  }
}
```

Hash private input rather than logging it. Do not record API keys, authorization
headers, raw environment variables, private prompts, or customer data.

## Event log

Store typed SDK events as an append-only sequence when replay or diagnosis
matters:

```json
{
  "runId": "job-123:attempt-1",
  "sequence": 17,
  "receivedAt": "2026-07-31T00:00:02.345Z",
  "type": "tool_call",
  "agentId": "agent-...",
  "conversationId": "conv-...",
  "payloadSha256": "...",
  "sanitized": {
    "toolName": "lookup_ticket",
    "toolCallId": "call-..."
  }
}
```

- Consume until terminal `result`; assistant text is not terminal state.
- Preserve unknown event types rather than throwing them away or crashing.
- Keep a monotonic local sequence number and receipt timestamp.
- Record tool-call IDs, error classes, durations, and output hashes.
- Store full payloads only when the privacy/retention contract permits it.

## Effect receipts

For every mutation, capture the system-of-record receipt:

- database row version or transaction ID
- API request/response ID plus read-after-write verification
- file path, content hash, and Git commit
- queue/job ID and terminal status
- repository ID, file content hash, and commit SHA

Correlate the effect receipt with the run ID and tool-call ID. If the external
system offers no receipt, perform a bounded readback and hash the observed state.

## Test matrix

### Pure contract tests

- option and schema validation
- event reducer, including an unknown future event type
- tool input validation and bounded output
- authorization independent of model behavior
- idempotency-key behavior
- log redaction and feedback JSONL parsing

### Integration tests

- intended agent and conversation are selected
- CWD/resources exist in the execution environment
- allowed tool succeeds and denied tool is rejected
- tool-level error remains distinct from transport failure
- stream reaches a successful or failed terminal result
- session close releases local children and connections

### Live smoke test

Use the cheapest suitable model returned by `listModels()`. Exercise one
non-destructive end-to-end path. Capture agent/conversation/session IDs, terminal
result, timings, and an external readback receipt.

### Recovery tests

- controller restart resumes the stored conversation
- App Server reconnect re-establishes runtime and state before new work
- expired managed sandbox creates a fresh session around the same conversation
- timeout after a successful `send()` checks message history before retry
- duplicate controller delivery does not duplicate the product effect
- cleanup failure is observable and repairable

## Retry and recovery

Automatic retry is safe only when the SDK proves the message was not sent, such
as a pre-send managed-sandbox expiration. After an ambiguous connection failure:

1. Reconnect or resume the same conversation.
2. Inspect conversation messages and durable product state.
3. Reconcile the request idempotency key.
4. Retry only if neither the turn nor its effect exists.

Never clear conversation state to recover from a transport problem.

## Feedback categories

The bundled logger accepts:

- `smooth-path`
- `discovery`
- `installation`
- `types-api`
- `lifecycle`
- `tools-permissions`
- `events-provenance`
- `deployment`
- `docs-examples`
- `performance-cost`
- `other`

Use friction `none`, `low`, `medium`, `high`, or `blocking`. Nonzero friction
requires a specific suggestion. Evidence should be a sanitized test name, file
path, error class, timing, event type, or receipt ID.
