# Agent SDK recipes for routines

Working patterns for rungs 3–6 using `@letta-ai/letta-agent-sdk` (TypeScript). Verify against the installed version: the package is 0.x and moves; `node_modules/@letta-ai/letta-agent-sdk/dist/*.d.ts` is the authoritative surface. Docs: https://docs.letta.com/agent-sdk

```bash
bun init -y && bun add @letta-ai/letta-agent-sdk  # pin the exact version in package.json
```

## Client setup — start with cloud sandboxes

The default deployment for a routine: agent state lives in Letta Cloud, tools execute in a managed cloud sandbox the SDK creates for the session. Nothing to host for execution — your program is just the orchestrator.

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY, // scoped key provisioned for this routine
});
```

Backend selection in one line each:

- `backend: "cloud"` — managed sandbox per session. Default for routines.
- `backend: "cloud"` + `environment: { name: "work-laptop" }` — same hosted agent, tools run on a named connected computer (yours or your user's). Use a stable `deviceId`/`id` selector, not a `connectionId`.
- `backend: "local"` — everything on this machine; the SDK owns an App Server subprocess. For routines that must touch local files with no cloud state.
- `environment` and `sandbox` are mutually exclusive.

Sandbox facts that matter for routines: sandbox files are TTL-bound — durable state belongs in agent memory or storage your routine owns, never in the sandbox. A `cwd` you pass must be a path inside the sandbox; local paths are not mounted automatically. Expect 10–20s cold starts.

## Rung 3 — one-shot workflow

Run turns against an existing agent, produce a result, exit. Reuse the agent you already are (or your user's designated agent) rather than creating throwaway identities.

```ts
// release-audit.ts — invoked by hand or by another routine; runs once and exits.
const AGENT_ID = process.env.ROUTINE_AGENT_ID!; // agent-xxx

await using session = client.createSession(AGENT_ID); // new conversation for this run

await session.send(
  [
    "Audit the latest release for doc drift.",
    `Release notes:\n${releaseNotes}`,
    "Report: contradictions with current docs, deprecated references, required patches.",
  ].join("\n\n"),
);

for await (const event of session.stream()) {
  if (event.type === "assistant") process.stdout.write(event.content); // incremental chunks
  if (event.type === "result") {
    // event.result = full final text; event.success, event.stopReason, event.runIds
    await writeReceipt({ runIds: event.runIds, ok: event.success });
  }
}
// `await using` disposes the session; the conversation and its history persist on the agent.
```

Turn anatomy: one `send()` + one pass through `stream()`; the stream terminates after the turn's `result` event. `abort()` stops a turn without closing the session; `close()`/`await using` releases session-scoped resources (client tools, MCP connections, cwd/env). A session whose connection died cannot be reused — `resumeSession(conversationId)` and continue.

## Creating a dedicated routine agent

Only when the routine needs judgment that should accumulate separately from you — otherwise skip this and use an existing agent.

```ts
const agentId = await client.createAgent({
  name: "pr-shepherd",
  persona:
    "You review pull-request state for one repository. You judge staleness, risk, and what deserves human attention. You report conclusions, not raw data.",
});
// Persist agentId in the routine's own storage — this identity is the durable asset.
```

## Conversation-per-resource, with the map in your storage

Conversations are addressable state: `createSession(agentId)` opens a new one, `resumeSession("conv-xxx")` continues it. The resource→conversation map is operational truth and lives in the routine's storage, not in anyone's memory.

```ts
import { Database } from "bun:sqlite";
const db = new Database("routine-state.sqlite");
db.run(`CREATE TABLE IF NOT EXISTS resources (
  key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, last_event_id TEXT
)`);

async function sessionFor(resourceKey: string) {
  const row = db
    .query<{ conversation_id: string }, [string]>(
      "SELECT conversation_id FROM resources WHERE key = ?",
    )
    .get(resourceKey);
  if (row) return client.resumeSession(row.conversation_id);

  const session = client.createSession(AGENT_ID);
  await session.send(`You now own ${resourceKey}. Acknowledge.`);
  for await (const e of session.stream()) if (e.type === "result") break;
  db.run("INSERT INTO resources (key, conversation_id) VALUES (?, ?)", [
    resourceKey,
    session.conversationId!, // resolved after the backend assigns it
  ]);
  return session;
}
```

Justify the granularity first (see Step 3 of the skill): per-repo beats per-file when judgments need cross-file comparison.

## Rung 4 — scheduled routine

The program above, run by a scheduler. For yourself, use the `scheduling-tasks` skill (`letta cron`) rather than writing a daemon. For a standalone host, ordinary cron:

```
*/30 * * * * cd /opt/routines/pr-shepherd && bun run sweep.ts >> sweep.log 2>&1
```

One process per state directory; take a lock file so overlapping fires cannot double-run.

## Rungs 5–6 — watcher / event-driven service

The shape: deterministic ingest → dedupe against your ledger → one turn on the owning conversation → receipt. Agent judgment happens inside the turn; everything around it is ordinary code.

```ts
// One iteration of a poll loop or one webhook delivery.
async function handleEvent(evt: { id: string; resource: string; payload: string }) {
  const seen = db
    .query("SELECT 1 FROM effects WHERE event_id = ?")
    .get(evt.id);
  if (seen) return; // idempotent: already handled

  await using session = await sessionFor(evt.resource);
  await session.send(
    [
      `Event ${evt.id} on ${evt.resource}:`,
      evt.payload, // exact fresh evidence — never rely on conversation memory for current state
      "Decide: no action, or a one-line escalation with reason.",
    ].join("\n"),
  );

  for await (const e of session.stream()) {
    if (e.type === "result") {
      db.run("INSERT INTO effects (event_id, run_ids, at) VALUES (?, ?, ?)", [
        evt.id,
        JSON.stringify(e.runIds),
        Date.now(),
      ]);
      if (e.success && e.result?.startsWith("ESCALATE:")) await reportToCoordinator(e.result);
    }
  }
}
```

Worker → coordinator reporting is just another turn on the main conversation:

```ts
async function reportToCoordinator(packet: string) {
  await using main = client.resumeSession(MAIN_CONVERSATION_ID);
  await main.send(`[pr-shepherd] ${packet}`); // compact decision packet, not a transcript
  for await (const e of main.stream()) if (e.type === "result") break;
}
```

Before running either rung, read [operations.md](operations.md) — envelopes, cursors, reconciliation, provider readback, budgets, and recursion controls are mandatory at this level.

## Failure handling every routine needs

- **Expired sandbox:** `send()` throws `CloudManagedSandboxExpiredError` *before* transmitting. This is the one safe automatic retry: close, `resumeSession(conversationId)`, retry once.
- **Connection failure after `send()` succeeded:** do NOT blindly retry — the message may have reached the runtime. Reconcile with `client.conversations.listMessages(...)` or `bootstrapState()` first. Unknown send state is not retry permission.
- **Missed events while disconnected:** the SDK does not replay them. After resuming, reconcile from history.
- **Correlate everything by `runId`s** from the `result` event — that is your receipt linking events, history, and retries.

## Approvals inside routines

Unattended routines must not depend on interactive approval. Configure sessions so every allowed action is auto-approvable within the charter, and everything else is denied — a denial that escalates to a human beats a stalled hidden prompt. If a pending approval does strand (process died mid-turn), recover it in a new session with `recoverPendingApprovals()` rather than resending the message. See https://docs.letta.com/agent-sdk/permissions
