# Agent SDK recipes for automations

These examples show ways to use `@letta-ai/letta-agent-sdk` from TypeScript. The package is 0.x, so check the installed `node_modules/@letta-ai/letta-agent-sdk/dist/*.d.ts` types when an API is version-sensitive. Docs: https://docs.letta.com/agent-sdk

```bash
bun init -y && bun add @letta-ai/letta-agent-sdk  # pin the exact version in package.json
```

## Cloud sandbox

With the cloud backend, agent state lives in Letta Cloud. The SDK can create a managed cloud sandbox where the agent runs its tools.

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});
```

The SDK offers the following execution options:

- `backend: "cloud"` — a managed cloud sandbox runs tools for the session.
- `backend: "cloud"` with `environment: { name: "work-laptop" }` — a connected computer runs the tools. Stable selectors include `deviceId` and environment `id`. A `connectionId` identifies one live connection.
- `backend: "local"` — agent state and tools stay on the current machine. The SDK owns the App Server subprocess.
- `environment` and `sandbox` are mutually exclusive.

Sandbox files last until the sandbox expires. Agent memory, conversation history, or application storage can hold state that must outlive the sandbox. A `cwd` value refers to a path inside the sandbox. It does not mount a local path.

## One-off program

This example starts a new conversation on an existing agent, streams one turn, records the result, and exits.

```ts
// release-audit.ts — invoked by a person or another program.
const AGENT_ID = process.env.AUTOMATION_AGENT_ID!; // agent-xxx

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

## Dedicated automation agent

An automation can use an existing agent or create a dedicated agent. A dedicated agent keeps its memory and identity separate from other work.

```ts
const agentId = await client.createAgent({
  name: "pr-shepherd",
  persona:
    "You review pull-request state for one repository. You judge staleness, risk, and what deserves human attention. You report conclusions, not raw data.",
});
// The application can store agentId and resume this agent later.
```

## One conversation per resource

Conversations are addressable state: `createSession(agentId)` opens a new conversation, and `resumeSession("conv-xxx")` continues it. This example stores the resource-to-conversation map in SQLite.

```ts
import { Database } from "bun:sqlite";
const db = new Database("automation-state.sqlite");
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

Conversation granularity can follow the reasoning context. For example, one conversation per repository can compare related file changes. One conversation per pull request can keep a long review history.

## Scheduled program

The same program can run from `letta cron`, an operating-system scheduler, or another scheduling service. For example:

```
*/30 * * * * cd /opt/automations/pr-shepherd && bun run sweep.ts >> sweep.log 2>&1
```

A lock file can prevent two scheduled runs from using the same state at the same time.

## Event-driven program

This example accepts an event, checks a local record, sends the event to the resource conversation, and records the Agent SDK run IDs.

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
      evt.payload,
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

A worker conversation can report a conclusion to a coordinator conversation:

```ts
async function reportToCoordinator(packet: string) {
  await using main = client.resumeSession(MAIN_CONVERSATION_ID);
  await main.send(`[pr-shepherd] ${packet}`);
  for await (const e of main.stream()) if (e.type === "result") break;
}
```

[Operations options](operations.md) describes event envelopes, cursors, reconciliation, action records, limits, and manifests for repeated programs.

## Connection and retry behavior

- `CloudManagedSandboxExpiredError` occurs before `send()` transmits the message. The program can resume the same conversation in a new session and retry once.
- A connection failure after `send()` succeeds has an unknown delivery state. `client.conversations.listMessages(...)` or `bootstrapState()` can show whether the message reached the conversation before the program retries it.
- The SDK does not replay stream events missed during a disconnect. Conversation history provides the durable record after the program resumes.
- The `result` event includes run IDs that can connect stream events, history, and application records.

## Approval options

An Agent SDK session can ask for interactive approval, approve selected tools through `canUseTool`, or deny an action and report it to the application. If a session closes with an approval pending, a new session can inspect it with `recoverPendingApprovals()`. See https://docs.letta.com/agent-sdk/permissions
