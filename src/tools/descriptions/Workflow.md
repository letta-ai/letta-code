Execute a workflow script that orchestrates multiple subagents deterministically (loops, conditionals, fan-out) rather than model-driven.

Workflows run in the background: this tool returns immediately with a task ID, and a <task-notification> carrying the script's return value arrives when the workflow completes. Do not poll or sleep for it, and never fabricate the result before it arrives. TaskStop aborts the run.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration — they asked for a workflow or multi-agent orchestration in their own words ("use a workflow", "fan out agents"), or invoked a skill whose instructions call this tool. Workflows can spawn many subagents and cost real money. For any other task, even one that would benefit from parallelism, describe what a workflow could do and ask first.

Scripts are plain JavaScript and must begin with `export const meta = {...}`, a pure literal (no variables, calls, or interpolation). Pass the work list via `args`. Prefer `pipeline()` so each item moves to its next stage as soon as it is ready; `agent()` resolves to `null` on failure, so guard and filter:

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
    (review, f) => parallel((review?.bugs ?? []).map(bug => () =>
      agent(`Is this a real bug in ${f}? ${bug}`, { phase: 'Verify', schema: verdict })
        .then(v => v?.real ? { file: f, bug } : null))),
  )
  return results.filter(Boolean).flat().filter(Boolean)

Before authoring a script, load the `workflow-authoring` skill — the script API, pipeline-vs-barrier rules, quality patterns, worked examples, and how to diagnose a run.
