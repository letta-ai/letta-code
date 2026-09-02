---
name: workflow-authoring
description: Reference for writing a Workflow tool script (script API and gotchas, pipeline-vs-barrier rules, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.
---

# Workflow authoring reference

A workflow structures work across many subagents — to be comprehensive
(decompose and cover in parallel), to be confident (independent perspectives
and adversarial checks before committing), or to take on scale one context
can't hold (migrations, audits, broad sweeps). The script is where you encode
that structure: what fans out, what verifies, what synthesizes.

When you do call the Workflow tool, the right move is often **hybrid**: scout
inline first (list the files, scope the diff, find the modules) to discover
the work-list, then call Workflow to pipeline over it, passing the list via
`args`. You don't need to know the shape before the *task* — only before the
*orchestration step*.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each → verify

For larger work, run several in sequence — read each result before deciding
the next phase. You stay in the loop; each workflow is one well-scoped
fan-out.

To iterate on a workflow, write the script to a file and invoke the tool with
`scriptPath`; edit the file and re-invoke with the same `scriptPath` plus
`resumeFromExecutionId` instead of re-sending the full script.

Every script must begin with `export const meta = {...}`:

    export const meta = {
      name: 'find-flaky-tests',                       // kebab-case, required
      description: 'Find flaky tests and propose fixes',  // required
      phases: [                                       // one entry per phase() call
        { title: 'Scan', detail: 'grep test logs for retries' },
        { title: 'Fix', detail: 'one agent per flaky test' },
      ],
    }
    // script body starts here — use agent()/parallel()/pipeline()/phase()/log()

The `meta` object must be a PURE LITERAL — no variables, function calls,
spreads, or template interpolation. Use the SAME phase titles in meta.phases
as in phase() calls — titles are matched exactly.

Workflow subagents currently require the API backend; the local store does not
support agent-free conversations.

## Script body hooks

- `agent(prompt, opts?)` → Promise. Spawn one subagent. Without `schema`,
  resolves to its final text. With `schema` (a JSON Schema), the subagent is
  given a StructuredOutput tool and agent() resolves to the validated object.
  Resolves to `null` if the subagent fails terminally — filter with
  `.filter(Boolean)`. Options: `label` (display override), `phase` (progress
  group — use this inside pipeline()/parallel() stages to avoid races on the
  global phase() state), `schema`, `model` (default to omitting it — the
  subagent inherits the invoking conversation's model),
  `effort` (reasoning tier; use 'low' for cheap mechanical stages, higher for
  the hardest verify/judge stages — a call that sets `model` or `effort`
  runs on a fresh regular conversation of the ephemeral worker instead of a
  stateless session, still isolated per call), `allowedTools` (defaults to read-only:
  Read, Grep, Glob — widen per call for stages that must write), `systemPrompt`
  (extra system prompt for this subagent), `cwd`, `timeoutMs`.
- `pipeline(items, stage1, stage2, ...)` → run each item through all stages
  independently, NO barrier between stages. Item A can be in stage 3 while
  item B is still in stage 1. This is the DEFAULT for multi-stage work.
  Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every
  stage callback receives `(prevResult, originalItem, index)` — use
  originalItem/index in later stages to label work without threading context
  through stage 1's return value. A stage that throws drops that item to
  `null` and skips its remaining stages.
- `parallel(thunks)` → run zero-arg functions concurrently. This is a
  BARRIER: it awaits all thunks before returning. A thunk that throws
  resolves to `null` in the result array — the call itself never rejects, so
  `.filter(Boolean)` before using the results. Use ONLY when you genuinely
  need all results together.
- `phase(title)` — start a new phase; subsequent agent() calls are grouped
  under this title in progress output.
- `log(message)` — emit a progress message to the user.
- `args` — the value passed as the tool's `args` input, verbatim. Pass
  arrays/objects as actual JSON values, NOT as a JSON-encoded string (a
  stringified list reaches the script as one string, so `args.filter` /
  `args.map` throw).
- `budget` — `{totalUsd, spentUsd(), remainingUsd()}` from the tool's
  `budgetUsd` input. The ceiling is HARD, not advisory: once `spentUsd()`
  reaches `totalUsd`, further agent() calls throw. `remainingUsd()` returns
  Infinity when no budget was set — guard loops on `budget.totalUsd`.
- `workflow(scriptPath, args?)` — run another workflow script inline as a
  sub-step and return whatever it returns. The child shares this run's
  concurrency cap, budget, abort signal, and journal. Nesting is one level
  only: workflow() inside a child throws.
- `sleep(ms)` — await a delay.

Subagents are told their final text IS the return value (not a human-facing
message), so they return raw data. They run as isolated stateless sessions
with no access to your memory or conversation — put ALL context they need in
the prompt.

Scripts are plain JavaScript, NOT TypeScript — type annotations, interfaces,
and generics fail to parse. The script body runs in an async context — use
`await` directly and `return` the final result. Standard JS built-ins (JSON,
Math, Array, etc.) are available — EXCEPT `Date.now()` / `Math.random()` /
argless `new Date()`, which throw (they would break resume); pass timestamps
in via `args`, and for randomness vary the agent prompt/label by index. No
filesystem or network access from the script itself.

## Pipeline vs barrier

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages)
when stage N needs cross-item context from all of stage N−1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage:
  `pipeline(items, stageA, r => transform([r]).flat(), stageB)`
- "The stages are conceptually separate" — that's what pipeline() models.
  Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the
  slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders'
  idle time.

Concurrent agent() calls are capped per run — excess calls queue and run as
slots free up, so passing 100 items is fine. Total agent count across a run
is capped at 1000 — a runaway-loop backstop. A single parallel()/pipeline()
call accepts at most 4096 items.

When a barrier IS correct — dedup across all findings before expensive
verification:

    const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
    const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // needs ALL at once
    const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))

Loop-until-count pattern — accumulate to a target:

    const bugs = []
    while (bugs.length < 10) {
      const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
      bugs.push(...result.bugs)
      log(`${bugs.length}/10 found`)
    }

Loop-until-budget pattern — scale depth to the budgetUsd input. Guard on
budget.totalUsd: with no budget set, remainingUsd() is Infinity and the loop
would run straight to the 1000-agent cap.

    const bugs = []
    while (budget.totalUsd && budget.remainingUsd() > 0.25) {
      const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
      bugs.push(...result.bugs)
      log(`${bugs.length} found, $${budget.remainingUsd().toFixed(2)} remaining`)
    }

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens
panel → loop-until-dry):

    const seen = new Set(), confirmed = []
    let dry = 0
    while (dry < 2) {                                              // loop-until-dry
      const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
        agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
      const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
      if (!fresh.length) { dry++; continue }
      dry = 0; fresh.forEach(b => seen.add(key(b)))
      const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
        parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
          agent(`Judge "${b.desc}" via the ${lens} lens — real?`, {phase: 'Verify', schema: VERDICT})))
          .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
      confirmed.push(...judged.filter(v => v.real).map(v => v.b))
    }
    return confirmed
    // dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round and it never converges.

## Quality patterns — pick by task and compose freely

- **Adversarial verify**: spawn N independent skeptics per finding, each
  prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong
  findings from surviving.

      const votes = await parallel(Array.from({length: 3}, () => () =>
        agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, {schema: VERDICT})))
      const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2

- **Perspective-diverse verify**: when a finding can fail in more than one
  way, give each verifier a distinct lens (correctness, security, perf,
  does-it-reproduce) instead of N identical refuters — diversity catches
  failure modes redundancy can't.
- **Judge panel**: generate N independent attempts from different angles
  (e.g. MVP-first, risk-first, user-first), score with parallel judges,
  synthesize from the winner while grafting the best ideas from runners-up.
  Beats one-attempt-iterated when the solution space is wide.
- **Loop-until-dry**: for unknown-size discovery (bugs, issues, edge cases),
  keep spawning finders until K consecutive rounds return nothing new.
  Simple counters (while count < N) miss the tail.
- **Multi-modal sweep**: parallel agents each searching a different way
  (by-container, by-content, by-entity, by-time). Each is blind to what the
  others surface; useful when one search angle won't find everything.
- **Completeness critic**: a final agent that asks "what's missing —
  modality not run, claim unverified, source unread?" What it finds becomes
  the next round of work.
- **No silent caps**: if a workflow bounds coverage (top-N, no-retry,
  sampling), `log()` what was dropped — silent truncation reads as "covered
  everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders,
single-vote verify. "thoroughly audit this" or "be comprehensive" → larger
finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean
toward thoroughness for research/review/audit requests and toward brevity for
quick checks.

These patterns aren't exhaustive — compose novel harnesses when the task
calls for it (tournament brackets, self-repair loops, staged escalation,
whatever fits).

## Resume

The tool result includes an executionId, and every run persists its script, args,
and a journal of each subagent's outcome under
`~/.letta/workflows/executions/<executionId>/`. To resume after a failure, abort, or
script edit, re-invoke the tool with `scriptPath` + `resumeFromExecutionId` — calls
whose (prompt, options) are unchanged replay their journaled results
instantly; the first edited/new call and everything after it runs live. Same
script + same args → 100% cache hit. Cosmetic edits to `label`/`phase` keep
their cache hits; failed outcomes are never replayed. Before diagnosing why a
completed workflow returned an empty or unexpected result, read that run's
`journal.jsonl` — it records each agent's actual return value; do not assume
cached results are non-empty.
