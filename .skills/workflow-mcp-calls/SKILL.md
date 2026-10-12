---
name: workflow-mcp-calls
description: How to call an agent's MCP tools directly from a Workflow script via the `tools` global. Use when writing or reviewing a workflow script that needs to run one of the invoking agent's connected MCP tools without spawning a subagent.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-38f0c79e-5bcb-4f00-9483-3bad8b78ae0d"]'
  rationale: 'Agents repeatedly need the concrete pattern for calling an agent MCP tool from a Workflow script, and the constraints are easy to miss: only MCP tools are exposed on `tools`, and approval-required calls cannot prompt. Without it, an agent either spawns an unnecessary subagent or writes a script that fails on a hidden constraint.'
---

# Calling MCP tools from Workflow scripts

A Workflow script can call the invoking agent's MCP tools directly through the
`tools` global — no `agent()` subagent and no extra model turn are needed.

## Call pattern

Workflow scripts are plain JavaScript beginning with an `export const meta`
block. Call a tool as a method on `tools`, named `mcp__<Server>__<tool>` (the
MCP server alias is part of the tool name):

```js
export const meta = {
  name: "list-orgs",
  description: "Count the agent's PlanetScale organizations",
};

const result = await tools.mcp__PlanetScale__planetscale_list_organizations({});
const names = result.data.map((org) => org.name); // result shape is server-defined
return names.length;
```

Concrete server and tool names differ per agent; list an agent's callable
server aliases before writing the script.

Only **MCP tools** are exposed. Built-in tools such as `Bash` and `Read` are
`undefined` on `tools`; to run those, use `agent()`.

## Permissions and approval

- MCP calls run under the invoking turn's permission mode, so prefer
  read-only, idempotent tools in mechanical scripts.
- A tool that would normally ask for user approval **cannot prompt from a
  script**: the call throws instead unless an allow rule is in place. Add the
  allow rule first, or fall back to `agent()` so the agent turn can request
  approval.

## Results and errors

- MCP calls return structured content when the server provides it; otherwise
  JSON-parsed text when the text is JSON; otherwise the raw text.
- A failed call throws inside the script, so `try`/`catch` it when a call may
  fail.
- Inside `parallel()` or `pipeline()`, a failed call becomes `null` rather than
  aborting the run — check for null before consuming a result.
- The run is capped at 1,000 MCP calls; budget fan-out accordingly.

## When to use it

The direct pattern helps for fan-out and mechanical chains where the script
already knows the calls (list IDs, then fetch each). It does not help for a
single call, for steps where the model must read one result before choosing the
next call, or for approval-gated tools.

A `tools.*`-only script needs no user opt-in, while a script that calls
`agent()` or `decide()` spawns subagents and requires the user to have
explicitly asked for a workflow or multi-agent orchestration.

## Why this works / why it will be useful again

Workflow authors keep needing the same concrete pattern — call syntax, the
MCP-only boundary, the approval constraint, and the result/error semantics —
and they are easy to get wrong: only MCP tools exist on `tools`, approval-gated
calls throw instead of prompting, and failed calls surface as throws or nulls.
Capturing this as a project skill saves reconstructing it from the code or from
a live test run and prevents scripts that silently misuse the interface.
