---
name: building-with-letta-agent-sdk
description: Builds durable automations, agent-backed services, project infrastructure, and multi-agent systems with the Letta Agent SDK. Use when the user mentions the Letta Agent SDK, LettaAgentClient, @letta-ai/letta-agent-sdk, programmatic persistent agents, SDK-backed automation, client tools, MCP, Cloud/local/remote sessions, or asks an agent to build infrastructure for itself. Requires expectation-driven tests, event/effect provenance, and an agent-authored SDK feedback record after every use.
---

# Building with the Letta Agent SDK

Use the Agent SDK when persistent identity, memory, conversations, tools, or
multi-environment execution are part of the product. Do not wrap a one-shot
function in an agent because agents are fashionable this quarter.

## Before writing code

1. Fetch the current official docs. The SDK changes quickly; do not implement
   from model memory, stale snippets, or the deprecated package name.
   - https://docs.letta.com/agent-sdk/quickstart
   - https://docs.letta.com/agent-sdk/reference
   - https://docs.letta.com/agent-sdk/deployment
   - https://docs.letta.com/agent-sdk/mcp
2. Verify the installed package and its exported types:

   ```bash
   npm view @letta-ai/letta-agent-sdk version
   node -p "require('./node_modules/@letta-ai/letta-agent-sdk/package.json').version"
   ```

   The current package is `@letta-ai/letta-agent-sdk` and the high-level client
   is `LettaAgentClient`. `@letta-ai/letta-code-sdk` / `LettaCodeClient` are
   legacy surfaces. If live docs and installed types disagree, use the installed
   types for the build and record the discrepancy as feedback.
3. Read [design-patterns.md](references/design-patterns.md) before choosing a
   backend, identity/thread topology, or tool boundary.
4. Read [testing-and-provenance.md](references/testing-and-provenance.md) before
   defining the run contract or tests.

There is currently no Python Agent SDK. Use TypeScript/JavaScript or implement
the App Server WebSocket protocol directly only when the product truly needs
protocol-level control.

## Find the automation seam

Look for work where persistence changes the value:

- A role should learn from repeated work rather than restart from a prompt.
- A project needs a resident agent with durable context and a stable identity.
- A controller needs multiple agent roles, resumable threads, or background work.
- Application-owned data or actions should be available through narrow tools.
- The same manual coordination or synthesis recurs often enough to deserve a
  product contract.

Write the seam in one sentence before coding:

```text
When <trigger> occurs, persistent agent <role> receives <bounded context>, may
use <bounded capabilities>, writes <durable result>, and emits <effect receipt>.
```

If persistence, tools, or memory do not improve the workflow, use an ordinary
function, queue worker, or script.

## Define the contract

Specify these before implementation:

- **Product owner:** the database or service that owns users, tasks, jobs,
  authorization, idempotency, and effect receipts.
- **Agent owner:** the persistent agent ID and the memory that role may change.
- **Thread owner:** which workflow gets a new conversation and which resumes an
  existing one. Persist conversation IDs outside process memory.
- **Execution owner:** Cloud sandbox, named remote environment, local machine,
  or separately operated App Server.
- **Capability boundary:** built-in tools, client tools, MCP tools, repository
  resources, permissions, and secrets.
- **Result boundary:** the structured result, durable write, and receipt that
  proves the effect occurred.
- **Retry boundary:** what can be retried safely and how the controller detects
  a turn that may already have reached the runtime.

## Build one vertical slice

Install the current package and import from the current public surface:

```ts
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const client = new LettaAgentClient({ backend: "local" });

const agentId = await client.createAgent({
  persona: "You are the persistent maintainer for this project.",
  human: "The user expects concise evidence, explicit risks, and durable notes.",
});

await using session = client.createSession(agentId, {
  cwd: process.cwd(),
  permissionMode: "standard",
});

await session.send("Inspect the project and produce one bounded artifact.");
for await (const event of session.stream()) {
  // Persist typed events and preserve unknown event types.
  console.log(event);
}
```

Use this only as the shape. Re-check current docs and installed types before
copying it. Keep the first slice small enough to exercise the complete path:
identity, session, context, tool policy, event stream, durable result, cleanup,
and receipt.

## Prove the behavior

Write expectations before the live run. At minimum, test:

1. The intended agent and conversation are created or resumed.
2. The runtime sees the intended CWD/resources, not the SDK host path by
   accident.
3. Allowed and denied tools match the policy.
4. The event consumer reaches a terminal `result`, records unknown events, and
   does not mistake assistant text for completion.
5. Tool failure, permission denial, timeout, and restart/reconnect behavior are
   explicit.
6. A potentially ambiguous send is reconciled through message history before
   retry, avoiding duplicate work.
7. Session closure releases client tools, MCP processes, and managed runtime
   resources according to the selected backend.
8. The claimed product effect has an external receipt.

Prefer the cheapest suitable model returned by `session.listModels()` for smoke
tests. Do not hardcode a model handle from memory. Run expensive or externally
mutating tests only when authorized.

## Record SDK feedback every time

Every use of this skill must leave one agent-authored feedback record, including
smooth runs. Record what was expected, what actually happened, evidence, and a
specific streamlining suggestion when friction was nonzero.

Set `SKILL_DIR` to the Skill Directory shown when this skill loads, then run:

```bash
node "$SKILL_DIR/scripts/log-feedback.mjs" \
  --project "$PWD" \
  --surface local \
  --category lifecycle \
  --friction low \
  --summary "Session cleanup behavior was not obvious" \
  --expected "Closing the session would await all child cleanup" \
  --observed "Synchronous close returned before MCP shutdown completed" \
  --evidence "test/sdk-lifecycle.test.ts: closes MCP children" \
  --suggestion "Expose or document an async disposal receipt"
```

Default output:

```text
.letta/letta-agent-sdk-feedback.jsonl
```

Do not put credentials, private prompts, customer data, full model output, or
raw environment values in feedback. Use test names, file paths, sanitized error
classes, event types, timings, and receipt IDs. See
[testing-and-provenance.md](references/testing-and-provenance.md) for the schema
and categories.

When feedback reveals a repeated workflow problem, update this skill instead of
merely appending another complaint. When it reveals an SDK product problem,
preserve a minimal reproduction suitable for the SDK repository.

## Completion gate

Do not call the work complete until all are true:

- The source version and backend are identified.
- Identity, conversation, state, capability, retry, and effect ownership are
  explicit.
- Tests cover the declared expectations and failure paths.
- Runtime behavior has receipts rather than only source-code claims.
- Secrets and private context are absent from logs and feedback.
- The feedback JSONL record exists and parses.
- The final report names changed files, checks, runtime receipts, feedback path,
  and remaining risk.
