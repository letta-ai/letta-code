Execute a workflow script that orchestrates multiple subagents deterministically. Use for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

Workflows run in the background — this tool validates the script and returns immediately with a task ID (`workflow_N`) and the execution ID; a <task-notification> arrives when the workflow completes, carrying the script's return value. Do not poll or sleep for it: keep working or end your turn, and never fabricate the result before the notification arrives. TaskOutput on the task ID reads the progress log, TaskStop aborts the run, and the user can watch live progress with /workflows.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of subagent sessions and cost real money; the user must request that scale, not have it inferred. Explicit opt-in means: the user directly asked for a workflow or multi-agent orchestration in their own words ("use a workflow", "fan out agents", "orchestrate this with subagents"), asked for a comprehensive audit/sweep at a scale that plainly requires it, or invoked a skill whose instructions call this tool. For any other task — even one that would benefit from parallelism — describe what a workflow could do and ask first.

Every script must begin with `export const meta = {...}`: a PURE LITERAL (no variables, calls, or interpolation) giving the workflow's `name` (kebab-case), a one-line `description`, and optionally `phases` — one `{ title, detail? }` per phase() call, titles matched exactly. Scripts are plain JavaScript, not TypeScript.

The canonical multi-stage pattern — pipeline by default, each item verifies as soon as its review completes:

  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => review ? parallel(review.findings.map(f => () =>
      agent(`Adversarially verify: ${f.summary}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v})))) : []
  )
  return { confirmed: results.filter(Boolean).flat().filter(Boolean).filter(f => f.verdict?.real) }

Script hooks: agent(prompt, opts?) spawns one subagent and resolves to its final text — or, with opts.schema (a JSON Schema), the validated object; null on terminal failure (filter with .filter(Boolean)). Options: label, phase, schema, model, effort, allowedTools, systemPrompt, cwd, timeoutMs. pipeline(items, ...stages) runs each item through all stages independently with NO barrier between stages; each stage receives (prevResult, originalItem, index); a throwing stage drops that item to null. parallel(thunks) runs zero-arg functions concurrently and IS a barrier — use only when a stage genuinely needs all prior results together. phase(title) groups subsequent agents in progress output (inside concurrent stages use opts.phase instead — the global phase races). log(message) emits a narrator line. args is the invocation's args input, verbatim. budget is {totalUsd, spentUsd(), remainingUsd()} — the budgetUsd ceiling is HARD. sleep(ms) awaits a delay. workflow(scriptPath, args?) runs another workflow script inline as a sub-step and returns whatever it returns — the child shares this run's concurrency cap, budget, abort signal, and journal; nesting is one level only. Date.now(), argless new Date(), and Math.random() throw inside scripts (they would break resume); pass timestamps via args.

Subagents run in isolated agent-free ephemeral conversations with read-only tools by default (Read, Grep, Glob) and no access to your memory or conversation — put ALL context they need in the prompt. Their model defaults to the invoking conversation's model. They are told their final text IS the return value, so they return raw data. Concurrency is capped (excess agent() calls queue); a lifetime cap of 1000 agents per run is the runaway-loop backstop.

Workflow subagents currently require the API backend; the local store does not support agent-free conversations.

Every run persists its script and a journal of each subagent's outcome under ~/.letta/workflows/executions/<executionId>/ (the execution ID is in the tool result). To resume after a failure or script edit, re-invoke with resumeFromExecutionId — unchanged agent() calls replay instantly. Before diagnosing an empty or unexpected result, read that run's journal.jsonl; it records each agent's actual return value.

Before authoring a script, load the `workflow-authoring` skill — the workflow authoring reference: script API and gotchas, pipeline-vs-barrier rules, resume, quality patterns (adversarial verify, judge panel, loop-until-dry), and worked examples.
