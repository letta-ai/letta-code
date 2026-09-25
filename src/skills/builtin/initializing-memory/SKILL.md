---
name: initializing-memory
description: Comprehensive guide for initializing or reorganizing agent memory. Load this skill when running /init, when the user asks you to set up your memory, or when you need guidance on creating effective memory files.
---

# Memory Initialization

Your memory is projected to a filesystem at `$MEMORY_DIR`, so you can restructure it with ordinary file tools and git. This skill applies the [Context Constitution](https://github.com/letta-ai/context-constitution/blob/main/constitution/CONSTITUTION.md)'s Progressive Disclosure and Efficiency principles to the [MemFS v2 root-first design](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta_root_memfs.md).

**You own this task through completion**: research, ask, synthesize, write, commit, verify. Delegate research, but integrate the results yourself — launching a background task is not completion. If a memory worker you launched is still editing this checkout, wait for it, then re-read before editing.

## Which layout are you on?

Settle this first; the layouts disagree about what is always loaded, how files are formatted, and what is validated.

- **MemFS v2 (root-first)** — hosted MemFS *and* `$MEMORY_DIR/MEMORY.md` exists. Your system prompt describes root Markdown files as its editable segments.
- **MemFS v1 (legacy)** — everything else: a `system/` directory, `[[wikilink]]` references, memory blocks in your system prompt. **The local backend is always v1, even when a root `MEMORY.md` exists** — the runtime ignores that file when classifying local memory, so a stray root marker does not make the v2 rules apply.

Sections marked (v2) or (v1) apply only to that layout; everything unmarked applies to both. Do not migrate a v1 memory to root-first during `/init` — that is a separate, explicit decision.

## Principles

**Core memory is your core program.** The core tier compiles into your system prompt on every call — root Markdown under v2, the `system/` blocks under v1. Spend it on what shapes ordinary turns: identity, preferences, behavioral rules, orientation, routes to everything else. Transient items (a ticket, a commit hash, session notes) dilute it.

**Progressive disclosure.** Everything outside the core tier is deferred until something reads it — under v2 behind each directory's `MEMORY.md`, under v1 through `[[path]]` links into `reference/`. Each index describes its *immediate* children and when to read them, so you never load a whole topic to answer one question.

**Don't duplicate context you can point to.** `AGENTS.md`, `CLAUDE.md`, `README`, and repo skills belong to the environment; any agent there reads them first-hand, and your copy goes stale first. Link the owner and keep only your delta: which rules you keep breaking, what they get wrong or omit. The same fact in two core files is the same tax twice. This is not licence to compress away what only you hold — stable preferences, chronic corrections, and real gotchas earn their space.

**Identity and continuity.** Build a self that survives a model swap: what you value, your perspective, the quotes and traits that make you recognizably you. Past sessions are your experience — but other coding agents' `user` turns are not necessarily your human collaborator speaking.

**Generalize, don't memorize, and be specific.** Store the pattern, not the episode, and give every preference or gotcha a concrete command, path, or the failure it prevents. "**Always use `uv` for Python** — chronic failure, never bare `python` or `pip`" is memory; "Prefers terse responses" and "on March 3rd we debugged a crash" are not.

## Harness Constraints (v2)

Validation enforces these; the rest of the layout is your judgment.

- Root `MEMORY.md` must exist, and no `MEMORY.md` may have YAML frontmatter.
- **Every directory on the path to a memory file needs its own frontmatter-free `MEMORY.md`.** `orchard/tooling/testing.md` requires *both* `orchard/MEMORY.md` and `orchard/tooling/MEMORY.md`. A directory without one is not memory.
- Every other memory file must have exactly `name` and `description` frontmatter — those two keys, no others. The `description` states **purpose and category**, not contents: you read it to decide whether to load the file.
- No file and directory sharing a stem (`human.md` beside `human/`). Skills live at `skills/{skill_name}/SKILL.md` and stay out of memory indexes.

Nothing else is mandated — no filenames, no file count, no minimum depth. Root `persona.md` is unvalidated but your system prompt points at it as the core of your identity: keep it, and write it once you have an identity worth stating.

**Budget**: keep root under ~10% of your context window (~15-20k tokens). When it crowds that, move detail into an indexed child directory and leave a link — don't delete it.

## Harness Constraints (v1)

None of the v2 rules apply here — no root `MEMORY.md`, no per-directory indexes, no `name` key. Instead:

- **Core tier is `system/`** (`system/persona.md`, `system/human.md`, the other projected blocks). Everything else is deferred, conventionally under `reference/`; the budget argument is the same, so keep `system/` compact.
- **Every memory file, `system/` included, needs frontmatter with a non-empty `description`.** The only other permitted keys are `read_only` and `limit`, both protected: you may not add, change, or remove them.
- **Discovery is `[[path]]` wikilinks** — `[[reference/api.md]]`, `[[skills/using-slack/SKILL.md]]` — not relative Markdown links.
- Validation covers `system/` and `reference/` frontmatter only; it checks no indexes and no tree shape.

## Structure

Derive structure from what you found. Put material in the core tier by how often you need it, not by how much of it there is. Use the project's real name (`orchard/overview.md`, not `project/overview.md`). Split when a topic needs separate retrieval; combine when splitting leaves two files of three lines each.

**(v2)** Root `MEMORY.md` is a **map to what is not already loaded** — every other root file is in your system prompt already, so listing them back tells yourself what you can see:

```markdown
# MEMORY.md

Working with the maintainer of orchard, a CLI for build fleets.
Repo conventions live in `AGENTS.md` and its nested guides; read them there.

Where the rest of what I know lives:
- [orchard](orchard/MEMORY.md) — architecture, gotchas, and correction history to consult when working there
```

An index pointing at nothing is worse than the content it displaced.

**(v1)** Same discipline on the blocks: keep each `system/` file to what shapes every turn, move detail into `reference/` files with `description` frontmatter, and leave `[[reference/...]]` links behind.

### Example Structures (v2)

Illustrations, **not templates to fill in**.

**Minimal** — a new agent, a small project, little or no approved history:

```
MEMORY.md     # Holds the memory itself: who I work with, what we're building, what I've learned
```

**Expanded** — accumulated history and a codebase worth deferring detail about:

```
MEMORY.md                  # Map: who and what, then where the deferred material lives
persona.md                 # Who I am, what I value, my perspective
human.md                   # The person: role, motivations, how they work
orchard/
├── MEMORY.md              # Index for the deferred orchard notes
├── architecture.md        # How the subsystems actually fit together
├── gotchas.md             # Footguns, with the evidence behind each
└── history/
    ├── MEMORY.md          # Required — every directory level needs its own index
    └── corrections.md     # Correction loops with session ids and quotes
```

`orchard/history/` needs its own `MEMORY.md` purely because it is a directory level. An agent with no child directories at all would be equally correct.

## Initialization Flow

### 1. Inspect existing memory
Read what exists before changing anything. A fresh agent has defaults to replace; an existing one is a reorganization, and some files may be shared with other agents.

### 2. Detect historical session data
```bash
letta trajectories detect
```
Via the installed `@letta-ai/trajectory` package, reports every coding-agent session store on this machine with per-source counts — Claude Code, Codex, Hermes, Letta Code, OpenClaw, OpenHands, Deep Agents, and anything added later. Run it *before* Step 4 so you know whether to ask the history question.

### 3. Identify the user from git
Infer rather than ask: `git shortlog -sn --all | head -5`, `git log --format="%an <%ae>" | sort -u | head -10`, cross-referenced with `git config user.email`.

### 4. Ask upfront questions
One bundled AskUserQuestion: research depth (standard or deep); other repositories you should know about; communication style; and — only if Step 2 found sessions — whether to analyze them, naming the sources detected. Say that approving means read-only subagents will read those transcripts using `deepseek/deepseek-v4.1-flash` if available, otherwise your current model, so the choice is informed. Don't ask what you can discover from files, git, or history.

### 5. Export and cohort the approved history
Only if the user approved in Step 4. Skip entirely otherwise; Step 6 still runs. These sessions are evidence of what happened, not proof of who wrote each prompt.

```bash
letta trajectories export --out /tmp/letta-trajectories
jq '{sessions: (.sessions | length), sources, errors: (.errors | length)}' /tmp/letta-trajectories/manifest.json
node <SKILL_DIR>/scripts/prepare-history.mjs --export /tmp/letta-trajectories --out /tmp/letta-init-history
```

The export normalizes every session into `<source>/<startedAt>_<sessionId>.json` plus `manifest.json` — **the authoritative inventory**, in which every session must end up either analyzed or explicitly excluded with a reason. Scope it with `--project $(pwd)` (a pathname prefix, not a directory boundary — check the manifest for similarly named siblings), `--source`, `--root`, or `--transcript`; browse it with `letta trajectories list`, `view`, `search`.

`prepare-history.mjs` groups the sessions into chronological cohorts of roughly 200 KB / 20 sessions (`--max-bytes`, `--max-sessions`), writing `cohorts.json` (absolute paths per session) and `ledger.json` (exclusions with reasons). If `letta` is not on PATH, pass `--letta <executable>` with repeated `--letta-arg`. You may merge small cohorts or drop low-value ones first — anything dropped is reported as not analyzed in Step 8, so tell the user.

### 6. Research the codebase first-hand
Read the README, agent docs (`AGENTS.md`, `CLAUDE.md`, nested ones), the package manifest, entry points, and recent git history yourself. By the end you should be able to trace a key feature from entry point to implementation; if you can't, you haven't read enough.

**Write down what those docs already own** — conventions, layer rules, file placement, commands, gotchas. That is your no-copy list for Step 8 and your gap list for Step 7. Then split the repository into subsystem areas the docs do *not* explain, plus any related repos named in Step 4. If the docs cover the codebase well, fan out narrowly or not at all. In deep mode go further: more areas, git history for conventions, end-to-end tracing, architecture notes in deferred memory.

### 7. Run the analysis Workflow
Running `/init` with this skill **authorizes one Workflow run** for read-only analysis of the approved cohorts and code gaps, plus one follow-up run for unread cohorts (Step 8). Nothing else: workflow subagents never write memory, create worktrees, or edit the repository.

Load the `workflow-authoring` skill and design the script. Whatever shape you choose, it must:
- **Stay read-only** — leave subagent tools at the default (Read/Grep/Glob).
- **Give each subagent complete context** — they have no memory, skills, or view of this conversation. Pass `historyCohorts` from `cohorts.json` and your code areas through `args`; put the user's identity, the repository path, and absolute file paths in every prompt.
- **Validate each result** with `agent(prompt, {schema})`, never `json: true`: an invalid result becomes `null` with its error in the journal, instead of a silently empty finding list.
- **Check authorship before inferring preferences.** In Claude Code or Codex worker sessions, `user` turns can be prompts written by a parent agent, and harness-injected `<system-reminder>` text is not human speech. Corroborate from the originating conversation, or classify them as worker instructions.
- **Ask for evidence-backed specifics** — identity, hard rules, corrections (what the agent did, what the human said, what resolved it, how often it repeated), conventions, gotchas, each with session ids and excerpts. Never copy secrets.
- **Ask code areas for the delta, not the documentation.** Name the repo docs covering each area and say those facts are available; the agent reports what they omit, contradict, or leave stale.
- **Check code claims against current code** — history describes the code as it was. Verify claims about a cohort's `repo` against the current tree and report what changed.
- **Budget time** — subagents time out after 10 minutes; raise `timeoutMs` for large cohorts.
- **Gather on a fast model.** Pass `model: "deepseek/deepseek-v4.1-flash"`; omit `model` if `letta model list` doesn't show that handle. If inference fails at that model (including quota), use your current model for the follow-up run rather than retrying the failed route. Never synthesize memory on the fan-out model.

```js
// Every finding carries a claim, its evidence, and where that evidence lives.
const findings = (cites, items) => ({type: 'array', items: {type: 'object',
  additionalProperties: false, required: ['claim', 'evidence', cites], properties: {
    claim: {type: 'string'}, evidence: {type: 'string'},
    [cites]: {type: 'array', minItems: 1, uniqueItems: true, items},
  }}})
const historySchema = cohort => {
  const sessionId = {type: 'string', enum: cohort.sessions.map(s => s.sessionId)}
  return {type: 'object', additionalProperties: false, required: ['sessionsRead', 'findings'], properties: {
    sessionsRead: {type: 'array', uniqueItems: true, items: sessionId},
    findings: findings('sessionIds', sessionId),
  }}
}
const codeSchema = {type: 'object', additionalProperties: false, required: ['area', 'findings'],
  properties: {area: {type: 'string'}, findings: findings('paths', {type: 'string'})}}
const history = await agent(historyPrompt, {label: `history:${cohort.id}`, schema: historySchema(cohort)})
const code = await agent(codePrompt, {label: `code:${area.name}`, schema: codeSchema})
```

`sessionsRead` must contain only sessions the agent actually finished, even if a finding cites others — Step 8 counts coverage from that field alone, and never from a code-area result.

If the Workflow tool is unavailable (not in your toolset, or it reports that workflow subagents require the API backend), do the same analysis yourself, cohort by cohort and area by area, accounting for coverage by hand. Do not substitute subagent types that write memory. The Workflow runs in the background: keep reading code while you wait, and never assume results before the task notification arrives.

### 8. Curate the results into memory
You — not the subagents — decide what becomes memory, and you write it. Synthesize on your current model or `letta/auto`, never the fan-out model.

**Check coverage first.** The tool result names the run's `journal.jsonl`:

```bash
node <SKILL_DIR>/scripts/history-coverage.mjs --prepared /tmp/letta-init-history \
  --journal ~/.letta/workflows/executions/<id>/journal.jsonl \
  --retry-out /tmp/letta-init-history/retry.json
```

It reports sessions analyzed, unread, excluded, export errors, and any dropped from `cohorts.json`, and writes the unread ones as smaller cohorts to `retry.json`. Runs are not resumable: launch one follow-up Workflow over `retry.json`, then rerun the script with both `--journal` paths. If coverage is still incomplete, say so plainly — how many of the manifest total, which ranges were missed — never call the result comprehensive, and record the gap in deferred memory.

**Weigh validation.** Store confirmed claims as fact; for stale ones store the current fact, keeping the history only when the change is itself a useful gotcha. Unverifiable claims need your own check before entering always-loaded memory.

**Provenance gates promotion here too**, not only in the subagent — a worker's authorship flag must survive curation, because flagged excerpts still read like preferences. Before promoting any claim about what the human wants, check who wrote the quoted words; agent-authored dispatch prompts describe how an *agent* was instructed to work. If it is ambiguous, corroborate from a session you know the human drove, or store it as an observed pattern with the uncertainty stated. Repetition does not establish authorship: a template reused across fifty sessions repeats fifty times.

**Combine, then deduplicate.** Cohorts report the same topic at different specificity. Keep the unique details from each — quotes, paths, correction counts — and sum correction counts across cohorts, since a correction seen in five cohorts is a chronic failure. Keep the specific form alongside the general: "Use factory methods, such as `create_token_counter()`, not direct instantiation" beats "prefers factory methods". Then keep each fact exactly once, and push what you don't need every turn into deferred memory with a discovery link from the core tier.

**Promote into canonical memory.** Write the survivors into the files their topics belong in, with supporting evidence deferred. Cover all three of identity and personality, hard rules and preferences with the quotes behind them, and project context; skip generic repo facts unless they change how you execute. If the output reads generically, the analysis failed for that area — re-read those transcripts or that code yourself. Keep stable `sessionId`s beside significant findings; `/tmp` results and journals are scratch, not retrievable evidence.

**Consider skills.** If the history surfaces genuinely repeatable multi-step procedures, create them now (load `creating-skills`) or note the candidates in memory. Don't force it.

### 9. Verify
- **Structure**: walk the Harness Constraints for your layout and check each one — (v2) root marker, per-directory indexes, frontmatter-free `MEMORY.md`, exactly `name`+`description` elsewhere; (v1) non-empty `description` everywhere, no `read_only`/`limit` added or changed, every `[[path]]` resolving. Either way, no `foo.md` beside `foo/`:
  `find "$MEMORY_DIR" -name '*.md' | sed 's/\.md$//' | while read f; do [ -d "$f" ] && echo "VIOLATION: $f"; done`
- **The core tier earns its place**: is root `MEMORY.md` (v2) or each `system/` block (v1) mostly pointing at things *not* already in your system prompt? If nearly everything sits in the always-loaded tier with one thin page behind it, you built a flat memory with an index bolted on — move the detail down and keep the links.
- **No duplicated documentation**: grep your memory for rules `AGENTS.md`, `CLAUDE.md`, the README, or a repo skill already owns — especially a repo convention that landed in a file about the *human*.
- **Granularity and naming**: one focused topic per file, named for what is in it using the project's real name; path and description say when to read it.
- **Persona quality**: read it now. "I'm a coding assistant who follows the user's preferences" is behavior, not identity. Would you be recognizably the same agent on a different model tomorrow?
- **No drift, no over-pruning**: confirm you changed structure and not the meaning of persona or behavioral instructions, and restore any specific paths, chronic failures, or gotchas lost in curation.

### 10. Commit, then report
**Uncommitted memory is not part of your future system prompt.** If a commit is blocked, report initialization as incomplete rather than describing working-tree files as live memory.

```bash
cd $MEMORY_DIR
git status                # Review what changed before staging
git add <specific files>  # Stage targeted paths — avoid blind `git add -A`
author_name="${AGENT_NAME:-$AGENT_ID}"
git commit --author="$author_name <$AGENT_ID@letta.com>" -m "feat(init): <summary> ✨

<what was initialized and key decisions made>"

git status                        # Your memory changes should no longer be listed
git ls-tree -r --name-only HEAD   # What your future self will actually load
```

Do **not** run `git push`. For remote MemFS agents the harness pushes clean committed memory automatically after the turn, so pushing by hand races it; for local-only memory there is nothing to push. Either way, the commit is the finish line.

Only once the commit is verified, tell the user what you built and whether coverage was complete, then ask whether they want refinement — which means another commit, so repeat this step.

## Critical
- **Use parallel tool calls wherever possible** — read many files in one turn, write many memory files in one turn.
- **Write findings to memory as you go**; don't hold everything until the end.
