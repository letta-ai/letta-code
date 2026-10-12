---
name: codemode-and-workflow-usage
description: How programmatic tool calling ("CodeMode") and the Workflow tool work in Letta Code, when each is needed, and the cost-based opt-in rule for running workflows. Use when designing, modifying, or testing the script-calling API (`tools.*`), deciding whether a separate CodeMode tool is warranted, or editing the Workflow tool description.
metadata:
  status: proposed
  confidence: high
  evidence: '["letta:conv-38f0c79e-5bcb-4f00-9483-3bad8b78ae0d"]'
  rationale: 'A maintainer conversation resolved repeated confusion about when a script-calling tool is needed, settled on one script API, and finalized a cost-sensitive opt-in rule. Without this, future agents would re-derive the API shape and constraints and could reintroduce a separate CodeMode tool or weaken the opt-in guidance.'
---

# CodeMode and Workflow Usage

Letta Code has one programmatic tool-calling surface: the Workflow tool's
`tools.*` global. Keep it that way; do not reintroduce a separate tool unless a
documented gap reappears.

## Script API (`tools.*`)

A workflow script calls agent MCP tools directly with
`await tools.mcp__<server>__<tool>(args)`; no `agent()` subagent is needed for
the call. Pass `wait: true` to the Workflow tool when the script's value must
return in the same turn; otherwise the workflow runs in the background and
reports its result in a later notification.

Constraints to preserve:

- `tools` exposes MCP tools only. Built-ins (Bash, Read, ...) stay off it; route
  those through `agent()` or use Bash directly.
- A tool that needs approval fails closed from a script (a background script
  cannot show a prompt); it needs an allow rule first.
- Each call takes a run concurrency slot and counts against the run's MCP call
  cap.
- If the scripting API is extended, keep the `tools.<name>(args)` shape plus
  `ALL_TOOLS` and `describeTool(name)`. The old `tool.call/list/search/describe`
  globals were removed; search was intentionally out of scope.

## When programmatic tool calling helps

Use it when the script already knows which calls to make and only the final
result matters to the model: fan-out with known arguments, filtering or
aggregating large results, and mechanical chains (pagination, retries, joining
two tools' results). It does not help for a single call, for steps that need one
result before choosing the next call, or for tools that need approval.

## CodeMode naming and placement

- Call the capability "CodeMode". Use "programmatic tool calling" only as prose;
  it is Anthropic's name for its hosted feature, so it is not a good product
  name, and the capability spans both CodeMode and Workflow `tools.*`.
- A standalone CodeMode tool was evaluated against Codex and pi and dropped:
  schema hiding is already handled by MCP tool search/call, chaining and
  filtering by Bash, and the same-turn result by Workflow `wait: true`. Prefer
  those paths over building a separate code-execution tool.

## Workflow opt-in rule (cost-based)

Workflow scripts that call `agent()` or `decide()` spend money on subagents and
model calls. Run a workflow only when the user explicitly asked for a workflow
or multi-agent orchestration ("use a workflow", "fan out agents") or a skill's
instructions call the tool; otherwise describe what a workflow could do and ask
first. Scripts that only call `tools.*` need no opt-in.

Keep this explicit-opt-in rule, tied to `agent()`/`decide()` cost, in the
Workflow tool description.

## Why this works / why it will be useful again

The script API and the opt-in rule were settled through live testing and a
maintainer rewrite, but they are easy to fragment or weaken: a future change
could expose built-ins on `tools`, add a separate CodeMode tool, or restore
`tool.call/list/search`. Retaining the API constraints and the decision rule
lets the next agent make those calls without re-deriving them from PR review
and reference harnesses.
