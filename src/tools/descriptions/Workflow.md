Execute a workflow script that orchestrates multiple subagents deterministically (loops, conditionals, fan-out) rather than model-driven.

Workflows run in the background: this tool returns immediately with a task ID, and a <task-notification> carrying the script's return value arrives when the workflow completes. Do not poll or sleep for it, and never fabricate the result before it arrives. TaskStop aborts the run. With `wait: true`, the workflow runs in the foreground instead and this tool returns the script's value directly; use it for short scripts.

Scripts that call `agent()` or `decide()` spend money on subagents and model calls. Run one only when the user explicitly asked for a workflow or multi-agent orchestration ("use a workflow", "fan out agents") or a skill's instructions call this tool; otherwise describe the workflow and ask first. Scripts that only call `tools.*` need no opt-in.

Scripts can call tools directly: `await tools.<name>(args)` for this turn's built-in tools and `await tools.mcp__server__tool(args)` for the agent's MCP tools, subject to the user's permission rules. `await listTools()` returns `[{ name, description }]`; `await describeTool(name)` returns `{ name, description, inputSchema }`, or `undefined` for an unknown tool.

Scripts are plain JavaScript and must begin with `export const meta = {...}`, a pure literal (no variables, calls, or interpolation). Pass the work list via `args`. Prefer `pipeline()` so each item moves to its next stage as soon as it is ready. Await `agent()` calls: failures reject with the cause, `callIndex`, and `conversationId` when available. `parallel()` and `pipeline()` let siblings finish, then reject if any callback failed; a failed pipeline item skips its remaining stages. Catch errors explicitly inside callbacks for best-effort processing.

  export const meta = {
    name: 'review-files',
    description: 'Review each file for bugs, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const findings = {type: 'object', properties: {bugs: {type: 'array', items: {type: 'string'}}}, required: ['bugs']}
  const verdict = {type: 'object', properties: {real: {type: 'boolean'}}, required: ['real']}
  const results = await pipeline(
    args.files,
    f => agent(`Review ${f} for bugs.`, { phase: 'Review', schema: findings }),
    (review, f) => parallel(review.bugs.map(bug => () =>
      agent(`Is this a real bug in ${f}? ${bug}`, { phase: 'Verify', schema: verdict })
        .then(v => v.real ? { file: f, bug } : null))),
  )
  return results.flat().filter(Boolean)

Before authoring a script, load the `workflow-authoring` skill — the script API, pipeline-vs-barrier rules, quality patterns, worked examples, and how to diagnose a run.
