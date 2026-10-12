---
name: codemode-and-workflow-usage
description: How Letta Code Workflow scripts call MCP tools programmatically, when to use CodeMode, and when workflow execution requires explicit user opt-in. Use when designing, modifying, or reviewing the script-calling API or Workflow tool description.
metadata:
  status: proposed
  confidence: high
  evidence: '["letta:conv-38f0c79e-5bcb-4f00-9483-3bad8b78ae0d"]'
  rationale: 'A maintainer conversation resolved repeated confusion about when a script-calling tool is needed, settled on one API, and tied multi-agent workflow execution to explicit user consent. Without this guidance, future changes could re-derive the interface or accidentally reintroduce a separate CodeMode tool or costly implicit orchestration.'
---

# CodeMode and Workflow Usage

Letta Code has one programmatic tool-calling surface: the Workflow tool’s
`tools.*` global. Keep it that way; do not add a separate CodeMode tool unless
a documented gap reappears.

## Calling MCP tools from scripts

A Workflow script can call a connected agent MCP tool directly—without an
`agent()` subagent or extra model turn:

```js
const result = await tools.mcp__<server>__<tool>(args);
```

The server alias is part of the method name, and the result shape is defined by
the MCP server. Use `wait: true` when the script’s value must return in the
same turn; otherwise the workflow runs in the background and reports later.

Preserve these constraints:

- `tools` exposes MCP tools only. Built-ins such as `Bash` and `Read` are not
  available there; use `agent()` or invoke Bash directly when appropriate.
- Approval-required tools cannot prompt from a script and fail closed unless an
  allow rule is already in place; fall back to `agent()` when interactive
  approval is required.
- Each call consumes a run concurrency slot and counts against the run’s MCP
  call cap. In parallel or pipeline execution, handle null or thrown failures
  before consuming results.
- If the API is extended, retain the `tools.<name>(args)` shape together with
  `ALL_TOOLS` and `describeTool(name)`. The old `tool.call/list/search/describe`
  globals were removed; search is intentionally out of scope.

Use programmatic calls when the script already knows which calls to make and
only the final result matters: fan-out with known arguments, filtering or
aggregating large results, and mechanical chains such as pagination or joins.
They do not help for a single call, for steps where a result must be read before
choosing the next call, or for approval-gated tools.

## CodeMode naming and placement

Call the capability “CodeMode”; use “programmatic tool calling” only as prose,
not as a competing product name. A standalone CodeMode tool was evaluated and
dropped: MCP search/call handles schema discovery, Bash handles chaining and
filtering, and Workflow `wait: true` handles same-turn results. Prefer those
existing paths over a second code-execution tool.

## Workflow opt-in rule

Workflow scripts that call `agent()` or `decide()` spend money on subagents and
model calls. Run one only when the user explicitly asked for a workflow or
multi-agent orchestration (for example, “use a workflow” or “fan out agents”)
or a skill’s instructions call the tool. Otherwise describe what a workflow
could do and ask first. Scripts that only call `tools.*` need no opt-in.

Keep this explicit-opt-in rule, tied to `agent()`/`decide()` cost, in the
Workflow tool description.

## Why this works / why it will be useful again

The direct call pattern and opt-in boundary are easy to weaken: a future change
could expose built-ins on `tools`, restore the removed `tool.*` API, add a second
CodeMode surface, or trigger paid orchestration without consent. Keeping the
interface constraints and decision rule together lets future agents implement
or review the feature without reconstructing it from code, experiments, or PR
history.
