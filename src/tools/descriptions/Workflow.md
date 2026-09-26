Execute a workflow script that orchestrates multiple subagents deterministically. Use for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

Workflows run in the background — this tool validates the script and returns immediately with a task ID (`workflow_N`) and output file path; a <task-notification> arrives when the workflow completes, carrying the script's return value. Do not poll or sleep for it: keep working or end your turn, and never fabricate the result before the notification arrives. Read the output file only when you need interim progress; TaskStop aborts the run.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of subagent sessions and cost real money; the user must request that scale, not have it inferred. Explicit opt-in means: the user directly asked for a workflow or multi-agent orchestration in their own words ("use a workflow", "fan out agents", "orchestrate this with subagents"), asked for a comprehensive audit/sweep at a scale that plainly requires it, or invoked a skill whose instructions call this tool. For any other task — even one that would benefit from parallelism — describe what a workflow could do and ask first.

Every script must begin with `export const meta = {...}`: a PURE LITERAL (no variables, calls, or interpolation) giving the workflow's `name` (kebab-case), a one-line `description`, and optionally `phases` — one `{ title, detail? }` per phase() call. Scripts are plain JavaScript, not TypeScript. The script runs in the CLI process with the CLI's privileges and the user approves it by reading it, so keep it to orchestration (deciding what runs, combining results); reading, searching, and writing belong in subagents, where the tool allowlist applies.

The canonical multi-stage pattern — pipeline by default, each item verifies as soon as its review completes:

  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const findingsSchema = {type: 'object', properties: {findings: {type: 'array', items: {type: 'object', properties: {file: {type: 'string'}, summary: {type: 'string'}}, required: ['file', 'summary']}}}, required: ['findings']}
  const verdictSchema = {type: 'object', properties: {real: {type: 'boolean'}, why: {type: 'string'}}, required: ['real', 'why']}
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: findingsSchema}),
    review => review ? parallel(review.findings.map(f => () =>
      agent(`Adversarially verify: ${f.summary}`, {label: `verify:${f.file}`, phase: 'Verify', schema: verdictSchema})
        .then(v => ({...f, verdict: v})))) : []
  )
  return { confirmed: results.filter(Boolean).flat().filter(Boolean).filter(f => f.verdict?.real) }

Script hooks: agent(prompt, opts?) spawns one subagent and resolves to final text. Prefer opts.schema (JSON Schema) for a validated object; invalid/missing results retry and then resolve to null with the validation error in the journal. opts.json still parses without validating; schema wins if both are supplied. Options: label, phase, schema, json, model, effort, allowedTools, systemPrompt, timeoutMs, maxToolCalls. pipeline(items, ...stages) runs each item through all stages independently with NO barrier between stages; each stage receives (prevResult, originalItem, index); a throwing stage drops that item to null. parallel(thunks) runs zero-arg functions concurrently and IS a barrier — use only when a stage genuinely needs all prior results together. phase(title) groups subsequent agents in progress output (inside concurrent stages use opts.phase instead — the global phase races). log(message) emits a progress line. args is the invocation's args input, verbatim.

decide(state, questions, opts?) answers typed questions about `state` with a calibrated Jev model over the authenticated `POST /v1/alpha/decisions` — no agent() call, no model fallback, model defaults to `~typesafe/jev-latest` and must be a Jev handle. Question types: `choice` (criteria map of option → description), `score` (criteria array), `noul` (0–1 certainty); each needs `instructions`. Resolves to `{model, answers, usage, id, provider}` with every answer marked `calibrated: true` (`probabilities`/`confidence` come back only when the model supplies them); invalid answers are retried once and then resolve the call to null, while transport errors throw. opts also takes provider, session_id, trace, user. The journal records model, cost, calibration, validity, and tokens for each decision API attempt, retries included — not the request; the run's totalTokens sums every attempt.

  const call = await decide(diffText, {ship: {type: 'choice', instructions: 'Ship this diff or hold it?', criteria: {ship: 'safe to merge', hold: 'needs another pass'}}})
  if (call?.answers.ship.choice === 'hold') log('holding')

Subagents run in isolated agent-free ephemeral conversations with read-only tools by default (Read, Grep, Glob) and no access to your memory or conversation — put ALL context they need in the prompt. Their model defaults to the invoking conversation's model; opts.model or the tool's model input accept any handle or alias from `letta model list`. They are told their final text IS the return value, so they return raw data. Concurrency is capped (excess agent() calls queue); a lifetime cap of 1000 agents per run is the runaway-loop backstop. Each subagent is also guarded: a 10-minute default timeout (override with opts.timeoutMs), at most 1000 unique tool calls by default (override with the positive safe integer opts.maxToolCalls), and a stop after three identical consecutive tool calls — a guarded call resolves to null and the journal records which guard fired.

Every run persists its script and a journal of each subagent's outcome under ~/.letta/workflows/executions/<id>/ (the paths are in the tool result). Before diagnosing an empty or unexpected result, read that run's journal.jsonl; it records each agent's actual return value. Workflow subagents require the API backend.

Before authoring a script, load the `workflow-authoring` skill — the workflow authoring reference: script API and gotchas, pipeline-vs-barrier rules, quality patterns (adversarial verify, judge panel, loop-until-dry), and worked examples.
