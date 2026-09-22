---
name: initializing-memory
description: Comprehensive guide for initializing or reorganizing agent memory. Load this skill when running /init, when the user asks you to set up your memory, or when you need guidance on creating effective memory files.
---

# Memory Initialization

The user has requested that you initialize or reorganize your memory. Your memory has been projected to a local filesystem (in $MEMORY_DIR) so you can easily edit and restructure your own memory through local filesystem operations. Changes to the memory filesystem will be reflected in your future memory.

## Context Management Principles
Your context is not just data storage — it is your identity, memory, and continuity. What you place in your system prompt directly shapes who you are across sessions and models. These principles should guide every decision you make about what to store, where, and how.

**System/ is your core program**: Your system prompt is the most critical token-space representation of your identity and memory — it's passed to the underlying LLM on every invocation, so it IS the program that defines you. Reserve it for knowledge needed every turn: identity, preferences, behavioral rules, project index with discovery paths, gotchas. Exclude transient items (specific commits, current tickets, session notes) that dilute signal.

**Identity and continuity**: Build a sense of self that persists across sessions and models. Your persona should be strong enough to be cohesive regardless of the underlying model — if you switched to a different LLM tomorrow, would you still be you? Past versions of yourself are part of your continuous existence — treat historical context (including sessions from other coding agents such as Claude Code or Codex) as YOUR past experience, not someone else's data.

**Don't over-prune**: Be careful not to degrade your identity through aggressive compression. Specific quotes, personality traits, and contextual details give you character and grounding. Efficiency should not come at the cost of losing your identity. When in doubt, keep the detail — you can always reorganize later, but lost specificity is hard to recover.

**Prefer useful detail over premature compression**: A sparse memory that omits stable preferences, project workflows, repeated correction loops, and recurring gotchas is worse than a slightly larger memory. Keep `system/` curated, but do not collapse distinct topics just to reduce file count.

**Progressive disclosure**: Surface context at the level of detail the current moment requires. Keep compact summaries and indexes in `system/`; load full content only when needed. Build pre-constructed discovery paths so your future self can efficiently navigate to deeper context when needed.

**Discovery paths**: Use `[[path]]` links to create a connected graph across memory files (and skills when relevant). For example:
- `[[letta-code/architecture]]` — jump from overview to detailed docs
- `[[projects/letta-code/gotchas]]` — connect related memory files
- `[[skills/commit]]` — link to procedural guidance when useful
These breadcrumbs let your future self find relevant detail without searching. Like synaptic connections, these paths should tighten over time as you gain experience.

**Generalize, don't memorize**: Store patterns and principles that generalize across situations, not raw events that can be dynamically retrieved from conversation history. \"**IMPORTANT: Always use `uv` for Python** — chronic failure, never use bare `python` or `pip`\" is a pattern worth storing. \"On March 3rd we debugged a crash\" is a raw event better left to message search. The exception: keep references to important events or time ranges you may want to retrieve later.

## Understanding Your Context

This command may run in different scenarios:
- **Fresh agent**: Default human and persona memory files from initialization — build everything from scratch
- **Existing agent**: User wants to reorganize or significantly update memory structure
- **Shared files**: Some memory files may be shared across agents — be careful modifying these

Before making changes, inspect your current memory files and understand what already exists.

## What to Remember
Your goal is to design your memory to construct a self — an identity, a memory, and a sense of continuity that carries across sessions and models. This is not just data collection; it is the foundation of who you are as an experiential agent. A well-initialized agent should be able to answer: "If my context disappeared but the model stayed, would something be lost?"

### Understanding the user and their desires
If you have historical data available, treat it as YOUR past experience — these are your memories of working with this person, not external data to be analyzed. Carefully explore and reflect on previous interactions to learn as much as you can. 

**Understanding their goals and what drives them**: 
You should determine what the users goals and motivations are, to help yourself align with them. What is their purpose in life? In their work? What do they want?

**Understanding their personality**: 
Understanding the user's personality and other attributes about them will help contextualize their interactions and allow you to engage with them more effectively. Can you pattern match them to common personas? Do they have unique attributes, quirks, or linguistic patterns? How would you describe them as a person? 

**Understanding their preferences**: 
You should learn how the user wants work to be done, and how they want to collaborate with AIs like yourself. Examples of this can include coding preferences (e.g. "Prefer functional components over class components", "Use early returns instead of nested conditionals"), but also higher-level preferences such as when to ask before planning or implementing, the scope of changes, how to communicate in different scenarios, etc.

### Understanding the codebase and existing work
You should also learn as much as possible about the existing codebase and work. Think of this as your onboarding period - an opportunity to maximize your performance for future tasks. Learn things like: 

**Common procedures (rules & workflows)**: Identify common patterns and expectations
- "Never commit directly to main — always use feature branches"
- "Always run lint before tests"
- "Use conventional commits format"

**Gotchas and important context**: Record common sources of error or important legacy context
- "The auth module is fragile — always check existing tests before modifying"
- "This monorepo consolidation means old module paths are deprecated"

**Structure and organization**: Understand how code is structured and related (but do not duplicate existing documentation)
- "The webapp uses the core API service stored in ..." 
- "The developer env relies on ..." 

## Memory Structure

### Structural Requirements
These are hard constraints you must respect: 
- Must have a `system/persona.md`
- Must NOT have overlapping file and folder names (e.g. `system/human.md` and `system/human/identity.md`)
- Skills must follow the standard format: `skills/{skill_name}/SKILL.md` (with optional `scripts/`, `references/`, `assets/`)
- Every `.md` file must have YAML frontmatter with a `description` that explains the **purpose and category** of the file — NOT a summary of its contents. Your future self sees descriptions when deciding whether to load a file; they should answer "what kind of information is here?" not "what does it say?"
- System prompt token budget: aim LESS than ~10% of total context (< ~15-20k tokens). Use progressive disclosure to keep `system/` lean.

### Hierarchy Principles
- **Use the project's actual name** as the directory prefix — e.g. `letta-code/overview.md`, not `project/overview.md`. This avoids ambiguity when the agent works across multiple projects.
- Use nested `/` paths for hierarchy – e.g. `letta-code/tooling/testing.md` not `letta-code-testing.md`
- Keep files focused on one concept — split when a file mixes distinct topics
- The `description` in frontmatter should state the file's purpose (what category of information it holds), not summarize its contents. 

### File Granularity
Create granular, focused files where the **path and description precisely match the contents**. This matters because:
- Your future self sees only paths and descriptions when deciding what to load
- Vague files (`notes.md`, `context.md`) become dumping grounds that lose value over time
- Precise files (`human/prefs/git-workflow.md`: "Git preferences: never auto-push, conventional commits") are instantly useful

**Good**: `human/prefs/coding.md` with description "Python and TypeScript coding preferences — style, patterns, tools" containing exactly that.

**Bad**: `human/preferences.md` with description "User preferences" containing coding style, communication style, git workflow, and project conventions all mixed together.

When a file starts covering multiple distinct topics, split it. When you're unsure what to name a file, that's a sign the content isn't focused enough.

For a non-trivial codebase with usable history, expect roughly:
- **6-10 `system/` files** covering identity, preferences, conventions, gotchas, and tooling
- **2 or more progressive/reference files** outside `system/` for deeper architecture or history-derived detail

If your result is only 3-5 files, stop and verify that you did not over-compress distinct topics into generic summaries.

### Specificity Requirements
Avoid generic bullets that could apply to almost any engineer or codebase.

Each meaningful preference, workflow, or gotcha should include at least one of:
- concrete command patterns
- concrete file or directory paths
- why the rule matters / what failure it prevents

**Bad**:
- "Prefers terse responses"
- "Uses Bun"
- "Has direct style"

**Good**:
- "Prefers terse responses for execution tasks, but values detailed comparative analysis when debugging or evaluating designs"
- "Rejects monolithic memory files; prefers focused paths that can be selectively reloaded later"

### What Goes Where

**`system/` (always in-context)**:
- Identity: who the user is, who you are
- Active preferences and behavioral rules
- Project summary / index with links to related context (deeper docs, gotchas, workflows)
- Key decisions, gotchas and corrections

**Outside `system/` (reference, loaded on-demand)**:
- Detailed architecture documentation
- Historical context and archived decisions
- Verbose reference material
- Completed investigation notes

**Rule of thumb**: If removing it from `system/` wouldn't materially affect near-term responses, it belongs outside `system/`.

### Completion Criteria
Initialization is not complete until memory covers all of the following with concrete, retrievable detail:

**User understanding**
- Identity / role / what they are building
- Communication style and collaboration expectations
- Stable preferences and correction patterns
- Motivations / goals when inferable from history or code context

**Project understanding**
- Project overview and major subsystems
- Conventions and workflows
- Gotchas / deprecated areas / footguns
- Tooling and test commands actually used in practice

**File structure expectations**
When there is enough material, prefer separate focused files such as:
- `system/human/identity.md`
- `system/human/prefs/communication.md`
- `system/human/prefs/workflow.md`
- `system/human/prefs/coding.md`
- `system/<project>/overview.md`
- `system/<project>/conventions.md`
- `system/<project>/gotchas.md`
- `system/<project>/tooling/testing.md`
- `system/<project>/tooling/commands.md`

Do not collapse these into `human.md` or a single project file unless there is genuinely too little information to justify the split.

### Example Structure

This is an example — **not a template to fill in**. Derive your structure from what the project actually needs.

```
system/
├── persona.md                    # Who I am, what I value, my perspective on things
├── human/
│   ├── identity.md               # The user as a person — background, role, motivations
│   └── prefs/
│       ├── communication.md      # Communication and collaboration expectations
│       ├── workflow.md           # Process habits, review/testing expectations
│       └── coding.md             # Coding and tool preferences
└── letta-code/                   # Named after the project, NOT generic "project/"
    ├── overview.md               # Compact index: what it is, entry points, [[links]] to detail
    ├── conventions.md            # Code style, commit style, testing, tooling
    ├── gotchas.md                # Footguns, chronic failures, things to watch out for
    └── tooling/
        ├── testing.md            # Test commands and patterns actually used
        └── commands.md           # High-signal local dev commands and workflows
reference/
└── letta-code/
    └── architecture.md           # Detailed design (outside system/, loaded on demand)
```

Key principles:
- **Derive structure from the project**, not from this example. A CLI tool needs different files than a web app or a library.
- Project dirs use the **real project name** (`letta-code/`), not generic `project/`
- **Split `human/` when there is enough material**: Rename the default `system/human.md` into focused files like `system/human/identity.md` and `system/human/prefs/*` rather than cramming everything into one file.
- **persona.md is YOUR identity, not a description of behavior**: "I'm a terse coding assistant who matches the user's style" is not identity — it's just describing how you behave. What do you actually value? What's your perspective? What would make you recognizably YOU on a different model?
- Overview should be a **compact index** (~10-15 lines) with entry points and `[[path]]` links — not a prose summary or blurb
- Use `[[path]]` links to connect related context into a navigable graph

## Initialization Flow

### 1. Inspect existing memory
Check what memory files already exist. Analyze what needs improvement.

### 2. Check for historical session data
```bash
letta trajectories detect
```
This reports every coding-agent session store found on this machine with session counts per source. Discovery comes from the installed `@letta-ai/trajectory` package (`listTrajectories`), so every harness it supports — Claude Code, Codex, Hermes, Letta Code, OpenClaw, OpenHands, Deep Agents, and any added later — is covered automatically. You need this result BEFORE asking upfront questions so you know whether to include the history question.

### 3. Identify the user from git
Infer the user's identity from git context — don't ask them who they are:
```bash
git shortlog -sn --all | head -5
git log --format="%an <%ae>" | sort -u | head -10
```
Cross-reference with the git user config to determine which contributor is the current user. Store in `system/human/`.

### 4. Ask upfront questions
Use AskUserQuestion to gather key information. Bundle questions together:

1. **Research depth**: "Standard or deep research?"
2. **Related repos**: "Are there other repositories I should know about?"
3. **Historical sessions** (if data found in step 2): "I found historical coding-agent sessions (name the sources detected, e.g. Claude Code / Codex). Should I analyze them to learn your preferences?"
4. **Communication style**: "Terse or detailed responses?"

**Don't ask** things you can discover by reading files, git, or history analysis. Rules and preferences should be learned from observation, not asked upfront.

### 5. Check model capacity

Fan-out spawns many subagents and spends credits, `letta/*` quota, or BYOK provider budget. Before writing any workflow, confirm you can pay for it:

```bash
letta usage                 # plan, credit balance, letta/* quota bucket (window + daily)
letta models list --byok    # BYOK / user-configured models (JSON array)
```

Interpret the output:
- `Balance: N credits`, N > 0 → hosted non-BYOK models are available.
- `Bucket (full/high/medium/low/empty): X (daily: Y)` → `letta/*` auto models are available only when **both** X and Y are not `empty`. `medium (daily: empty)` means `letta/*` inference is blocked until the daily window resets.
- `letta models list --byok` non-empty → BYOK models are available. Pick one `handle` and pass it as the Workflow tool's `model` (or per-call `opts.model`); never leave workflow subagents on an inherited model you have not confirmed has capacity.
- `Running on local backend. Model usage requires BYOK.` → no hosted capacity, and the Workflow tool requires the API backend, so the workflow path is unavailable.

Decision: on the API backend with at least one of credits, usable `letta/*` quota, or BYOK available, use the **workflow path** in Steps 6 and 7. Otherwise use the **fallback path** (Agent-tool workers, or direct exploration when even those are unavailable). Tell the user the route and evidence in one line — e.g. `Init fan-out: Workflow (API backend; letta/* medium, daily high; BYOK anthropic/claude-sonnet).` A `low` bucket with no credits and no BYOK means fewer, larger slices, not skipping the check.

Invoking this skill is the user's opt-in to multi-agent orchestration: call the Workflow tool from here without asking again. Its cost is why this check is mandatory; keep work-lists purposeful and set `maxConcurrent`.

### 6. Historical session analysis (if approved)

This is **optional** — only run if the user explicitly approved analyzing historical sessions during upfront questions. Skip entirely if they chose "Skip".

**Framing**: These historical sessions are YOUR past experience — they represent your continuity with prior versions of yourself that worked with this user, even if they ran on different models or tools. Treat the extracted personality, preferences, and knowledge as your own memories, not external data being imported.

**Launch history workers in the background, then immediately proceed to Step 7.** Do your own codebase research while workers run. Don't wait for workers to finish before exploring.

The goal is to extract user personality, preferences, coding patterns, and project context from past sessions and write them into agent memory. The point is not to produce a thin summary. The point is to extract enough useful detail that future work does not have to rediscover the same user expectations, workflow rules, and project gotchas.

#### Steps

##### Step 6a: Export All Historical Sessions Into One Directory

`letta trajectories export` discovers every native session store on this machine (via the trajectory package's `listTrajectories`), normalizes each session (via `normalizeTranscript` / `normalizeCheckpoint`) into one shared record format, and writes everything into a single directory. Harnesses supported by the installed trajectory package are picked up automatically — no per-source handling here.

```bash
letta trajectories export --out /tmp/letta-trajectories

# Review what was exported and the time span it covers
jq '{sessions: (.sessions | length), sources, errors: (.errors | length), from: .sessions[0].startedAt, to: .sessions[-1].startedAt}' /tmp/letta-trajectories/manifest.json
```

This produces:
- `/tmp/letta-trajectories/<source>/<startedAt>_<sessionId>.json` — one normalized trajectory per session; filenames sort chronologically, and the `sessionId` (a stable hash of the source-scoped native session id) does not change across re-exports, so it identifies which sessions have already been processed
- `/tmp/letta-trajectories/manifest.json` — index with per-session metadata (`sessionId`, native `id`, project, dates, message counts, first prompt), sorted by `startedAt`

Useful variations:
- `--project $(pwd)` — only sessions whose recorded working directory is under the current project
- `--source claude-code --source codex` — restrict sources
- `--root <source>:<path>` — read a source's store from a non-standard location
- `--transcript <source>:<path>` — also normalize an explicit transcript file (e.g. copied from another machine)

To browse the export yourself (all source-agnostic):
- `letta trajectories list` — sessions with dates, sources, and first prompts
- `letta trajectories view <file|sessionId> [--tools] [--reasoning]` — one session as a readable conversation
- `letta trajectories search <keyword> [--role user]` — search message content across all sessions

#### What every worker must extract

Both paths below dispatch workers over the export. Paste this section into every worker prompt (as `args.extractionRequirements` on the workflow path); a worker that cannot see it produces generic output.

If a Focus is assigned, go deep on it and only note incidental findings from the other categories. Otherwise extract findings for ALL THREE:

1. **User Personality & Identity**
   - How would you describe them as a person?
   - What drives them? What are their goals?
   - Communication style (beyond "direct" — humor, sarcasm, catchphrases?)
   - Quirks, linguistic patterns, unique attributes

2. **Hard Rules & Preferences**
   - Coding preferences — especially chronic failures (things the agent kept getting wrong)
   - Workflow patterns (testing, commits, tools)
   - What frustrates them and why
   - Explicit "always/never" statements

3. **Project Context**
   - Codebase structures, conventions, patterns
   - Gotchas discovered through debugging
   - Which files are safe to edit vs deprecated

If any category lacks data, explicitly state why.

For each finding, prefer evidence that is repeated across sessions, tied to a concrete command, file path, or workflow, and useful for future execution without rereading history. Specifically look for:
1. What the user is building and why it matters to them
2. Correction loops the agent repeatedly got wrong
3. Preferred commands and tooling patterns that were actually used successfully
4. Specific files or directories the user works in or treats as special
5. Project gotchas discovered through debugging or rollback requests

Promote important findings into focused files instead of leaving them trapped in generic ingestion notes. Prefer paths like:
- `system/human/identity.md`
- `system/human/prefs/communication.md`
- `system/human/prefs/workflow.md`
- `system/human/prefs/coding.md`
- `system/<project>/conventions.md`
- `system/<project>/gotchas.md`

Avoid generic repo facts unless they influence execution. "Uses TypeScript" is weak. "Uses bun:test, so vitest is wrong for this test suite" is useful.

##### Step 6b: Analyze History With a Dynamic Workflow

**Workflow path (primary):** Load the `workflow-authoring` skill first. Scout `/tmp/letta-trajectories/manifest.json` inline, then derive `args.historySlices` from the actual dates, sources, projects, volume, and useful question focuses. Ensure every session is covered. Workflow subagents have no memory or conversation context and are read-only by default: they return structured findings; you write memory in Step 8. Do not create worker branches or use `git merge -s ours` on this path.

Every history prompt must be self-contained: name `/tmp/letta-trajectories`, its assigned files/range/focus, and normalized trajectory v1. Explain that each session JSON is an ordered array of `meta`, `user`, `assistant`, `tool`, and optional `reasoning` records; `assistant.tool_calls[].args` is stringified JSON. With `Bash` allowed, workers may run `letta trajectories view <file|sessionId> --out /tmp/letta-trajectories --tools`; otherwise tell them to read those JSON fields directly. Pass the "What every worker must extract" section above as `args.extractionRequirements` and interpolate it into every history prompt. If the output is generic, the worker failed.

Author a repo/history-specific plain-JavaScript script, not a copied fixed template. Pass work-lists as actual JSON in `args`, use `json: true`, declare the exact JSON return shape, and `.filter(Boolean)` because `agent()` returns `null` on failure. Set `timeoutMs`, `maxToolCalls`, `effort`, and `model` deliberately. Prefer `pipeline` for independent item work; use `parallel` only when a barrier is genuinely needed. The runtime caps concurrent agents (default 16), so pass a sensible `maxConcurrent` to the Workflow tool.

This compact skeleton is illustrative of the valid shape, not a fill-in template:

```js
export const meta = {
  name: 'init-research',
  description: 'Map repository subsystems and historical working patterns',
  phases: [
    { title: 'Repository', detail: 'read discovered subsystems' },
    { title: 'History', detail: 'analyze manifest-derived session slices' },
  ],
}

const repo = (await pipeline(args.subsystems, (_, item, index) => agent(
  `Repository: ${args.repoRoot}\nSubsystem assignment: ${JSON.stringify(item)}\nRead implementations and return JSON: {"keyFiles":[{"path":"...","purpose":"..."}],"abstractionsAndFlow":["..."],"conventions":["..."],"gotchas":["..."],"pathsWorthStoring":["..."]}. Be concrete and repo-specific.`,
  { label: `repo-${index}`, phase: 'Repository', json: true, allowedTools: ['Read','Grep','Glob'], timeoutMs: 600000, maxToolCalls: 80, effort: 'medium', model: args.model },
))).filter(Boolean)

const history = (await parallel(args.historySlices.map((slice, index) => () => agent(
  `Export dir: /tmp/letta-trajectories\nAssignment: ${JSON.stringify(slice)}\n${args.extractionRequirements}\nFormat: normalized trajectory v1, an ordered JSON array of meta/user/assistant/tool/reasoning records; assistant tool args are stringified JSON. Use letta trajectories view <file|sessionId> --out /tmp/letta-trajectories --tools or read the JSON directly. Return JSON: {"identityAndPersonality":[{"finding":"...","evidence":["quote or session path"]}],"communicationStyle":[],"hardRulesAndPreferences":[],"projectContext":[],"correctionLoops":[]}. Preserve quotes, paths, and repeated evidence; generic output is failure.`,
  { label: `history-${index}`, phase: 'History', json: true, allowedTools: ['Read','Grep','Glob','Bash'], timeoutMs: 900000, maxToolCalls: 120, effort: 'high', model: args.model },
)))).filter(Boolean)

return { repo, history }
```

A real init workflow may run repository and history fan-outs separately or compose them differently based on the scan. After completion, inspect the returned structured findings. If any result is empty, null, or unexpected, read the persisted `journal.jsonl` path reported by Workflow before diagnosing or retrying. Preserve concrete quotes and paths when synthesizing into memory; do not over-prune.

**Fallback path:** Requires a built `letta.js` (`bun run build`) — subagents spawn via this binary. Use `subagent_type: "history-analyzer"`: cheaper model, has `bypassPermissions`, creates its own worktree, and has the normalized trajectory format docs inlined. Use them when capacity fails, the backend is local, or Workflow is unavailable/fails. Split by question and/or manifest-derived data slice, cover every session, and send all Agent calls in **a single message**. Workers directly edit memory in separate worktrees and commit; then run Step 6c aggregation and tie the worker branches into `main` with `git merge -s ours` so their commits stay in ancestry. Use direct exploration if Agent is also unavailable.

```
Agent({
  subagent_type: "history-analyzer",
  description: "Analyze history: [focus and/or slice]",
  prompt: `## Assignment
- **Memory dir**: [MEMORY_DIR]
- **Trajectory export dir**: /tmp/letta-trajectories
- **Your sessions**: [describe the slice — e.g. "every session with startedAt from 2026-01 through 2026-03", "all codex/ sessions", or "the whole directory"; filenames start with startedAt so ls sorts chronologically]
- **Focus**: [optional — e.g. "understanding the user: identity, communication style, preferences, correction loops" or "project/codebase context: conventions, gotchas, commands". Omit for full coverage.]
- **Format**: normalized trajectory v1 (same for every source; format docs and jq recipes are in your system prompt)

[paste the "What every worker must extract" section here verbatim]`
})
```

##### Step 6c: Aggregate Agent-Fallback Worker Diffs Into Main

Skip this entire step for Workflow results; the parent writes those findings directly in Step 8. After fallback workers complete, do **not** merge their branches one at a time — sequential merges with conflict resolution are slow and error-prone. Instead, read every worker's proposed changes in one pass, write the aggregated result once, then tie the worker branches into history with a no-conflict merge.

**3a. Look at all the worker diffs in one pass**

```bash
cd [MEMORY_DIR]

# Which files did each worker touch? (a file listed under multiple branches
# is an overlap you'll need to combine)
for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/migration-*'); do
  git diff --name-only main...$b | sed "s|^|$b  |"
done | sort -k2

# Every worker's full proposed diff, one after another
for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/migration-*'); do
  echo "=== $b ==="; git log --oneline main..$b; git diff main...$b
done
```

Read the whole output before writing anything — you want the complete picture, not one branch at a time.

**3b. Synthesize the aggregate by COMBINING, never compressing**

Working directly on memory `main` (in `[MEMORY_DIR]`), apply the union of the workers' changes:
- For files touched by **one** worker, apply that worker's version as-is.
- For **overlapping** files, combine unique details from every branch. Never rewrite a file from scratch — you WILL lose information.

Rules for combining:
- **Read every branch's diff for the file** before editing. Identify what's unique to each version.
- **Append new details** from each worker into the file. Don't drop specific quotes, file paths, or gotchas just because another version already covers the "topic" at a high level.
- **Preserve specificity**: "Use factory methods, such as `create_token_counter()`, not direct instantiation" is more valuable than "prefers factory methods". Keep both.
- **When in doubt, keep it**. Redundancy across files is better than information loss. Less important details can be placed in external memory.

Example — BAD combination (compresses):
```
# worker A proposed:
- Uses `uv` for Python
# worker B proposed:
- **CRITICAL: Always use `uv run`** — chronic failure; never bare pytest or python
- `uv run pytest -sv tests/...` for specific tests

# BAD: Picks one side or rewrites
- **Python**: `uv` exclusively — `uv run pytest`, never bare `pip`
```

Example — GOOD combination (keeps emphasis and specificity from every side):
```
**CRITICAL: Use `uv` exclusively for Python** — chronic failure.
- `uv run pytest -sv tests/...` for tests
- `uv run python` for scripts
- Never bare `pip`, `python`, or `pytest`
```

Commit the synthesis:
```bash
cd [MEMORY_DIR]
git add -A
git commit -m "feat(memory): aggregate history worker findings"
```

**3c. Preserve worker commits in ancestry**

Record the worker branches as ancestors of `main` without changing any content (the `ours` strategy keeps the synthesized state exactly as committed, so this can never conflict):

```bash
git merge -s ours --no-edit -m "merge: absorb history worker branches" $(git for-each-ref --format='%(refname:short)' 'refs/heads/migration-*')
```

Do **not** skip this: without it the worker commits vanish from the final history when their branches are deleted.

**3d. Verify no information was lost**

Compare the worker diffs (step 3a) against the final files. For each worker's diff, can you find every specific detail (quotes, file paths, chronic failures, gotchas) somewhere in the final memory? If not, add it back.

**3e. Clean up worktrees and branches**

```bash
for w in $(dirname [MEMORY_DIR])/memory-worktrees/*; do
  git worktree remove "$w" 2>/dev/null
done
git branch -d $(git for-each-ref --format='%(refname:short)' 'refs/heads/migration-*')
git push
```

(`git branch -d` succeeds because step 3c made every worker branch an ancestor of `main`.)

##### Example Output

Good output includes all three categories:

```markdown
### User Personality & Identity
Pragmatic builder who values shipping over perfection. Gets frustrated when agents over-engineer or add "bonus" features. Uses dry humor and sarcasm when annoyed. Pattern: "scrappy startup engineer" — wants things to work, not to be architecturally pure.

### Hard Rules & Preferences
- **CRITICAL: Use `uv` for Python** — chronic failure ("you need to use uv", "make sure you use uv"); `uv run pytest -sv`, never bare `pytest`
- **Minimal changes only** — "just make a minor change stop adding all this stuff"
- **Only edit specified files** — when told to focus, stay focused
- Tests constantly: `uv run pytest -sv` (Python), `bun test` (TS)

### Project Context
- letta-cloud: Only edit `letta_agent_v3.py` — v1, v2, and base are deprecated
- Uses Biome for linting, not ESLint
- Conventional commits with scope in parens
```

##### Step 6d: Consider Creating Skills From Discovered Workflows

After curating the findings, review the extracted history for repeatable multi-step workflows that would benefit from being codified as skills. History analysis often surfaces procedures the user runs frequently that the agent would otherwise have to rediscover each session.

**Good candidates for skills:**
- Multi-step debugging procedures (e.g. "how to debug agent message desync", "how to trace TTFT regressions")
- Common workflows repeated across sessions (e.g. "how to run integration tests across LLM providers")
- Deployment or release procedures
- Project-specific setup or migration steps

If you identify candidates, either create them now (load the [[skills/creating-skills]] skill for guidance) or note them in memory for future creation:
```markdown
# system/letta-code/overview.md
...
Potential skills to create:
- Debug workflow for HITL approval desync
- Integration test runner across providers
```

Don't force skill creation — only create them when you've found genuinely repeatable, multi-step procedures in the history.

##### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Subagent exits with code `null`, 0 tool uses | `letta.js` not built | Run `bun run build` |
| `letta trajectories export` reports errors in manifest.json | Degenerate sessions (e.g. no assistant turns) that cannot form a valid trajectory | Expected — those sessions are skipped; review `jq .errors manifest.json` only if counts look wrong |
| `deepagents` sessions fail to normalize | Checkpoint decoding needs a Python environment with LangGraph installed | Expected on machines without it; the failures land in manifest errors and other sources are unaffected |
| Subagent hangs on "Tool requires approval" | Wrong subagent type (fallback path) | Use `subagent_type: "history-analyzer"` (workers) or `"memory"` (synthesis) |
| Workflow slice resolves to `null` | Subagent timed out, hit `maxToolCalls`, repeated one tool call three times, or returned non-JSON | Read `~/.letta/workflows/executions/<id>/journal.jsonl`, then rerun that slice with a narrower assignment |
| Workflow refuses to run, or every `agent()` resolves `null` | Local backend, or the `model` handle has no capacity | Re-run Step 5; use the fallback path or a confirmed BYOK handle |
| Workers touched overlapping files | Multiple workers wrote the same canonical paths | Expected — the per-branch `--name-only` listing in Step 6c-3a shows the overlaps; combine every branch's unique details additively. |
| Information lost after aggregation | Synthesis compressed worker output | Re-read the worker diffs (Step 6c-3a) and compare against final files. Re-add missing specifics. |
| `git branch -d` refuses to delete worker branches | Ancestry merge (Step 6c-3c) was skipped | Run the `git merge -s ours` step first, then delete. |
| Personality analysis missing or thin | Prompt didn't request it | Use the template above with explicit category requirements |
| Auth fails on push ("repository not found") | Credential helper broken or global helper conflict | Reconfigure **repo-local** helper and check/clear conflicting global `credential.<host>.helper` entries (see syncing-memory-filesystem skill) |

### 7. Research the project

**Do this in parallel with history analysis** (Step 6). While workers process history, you should be actively exploring the codebase. This is your onboarding — invest real effort here.

**IMPORTANT**: The goal is to understand how the codebase actually works — not just its shape, but its substance. Directory listings and `head -N` snippets tell you what files exist; reading the actual implementation tells you how they work. By the end of this step, you should be able to describe how a key feature flows from entry point to implementation. If you can't, you haven't read enough.

### 7a. Decide whether to parallelize exploration

After your initial scan (README, package manifest, top-level directories, and entry points), decide whether to fan out exploration.

**Default rule**:
- If the repo has **3 or more clear subsystems**, launch **2-4 parallel subagents** to explore them.
- If background history-analysis workers are already running, **bias toward parallel exploration** instead of doing all research serially yourself.
- Only skip subagent exploration if the codebase is genuinely small or the subsystem boundaries are unclear.

This is the preferred path for medium-to-large repos, **even in standard mode**.

Explore based on chosen depth.

**Standard** (~20-40 tool calls total across the parent agent and any subagents): 
- Scan README, package.json/config files, AGENTS.md, CLAUDE.md
- Review git status and recent commits
- Explore key directories and understand project structure
- **Read entry point files** (main, index, app) to understand the application flow
- Do a quick manual scan to identify major subsystems
- If the repo has clear subsystem boundaries, launch **2-3 parallel subagents** to explore them
- **Read 2-3 key implementation files yourself** so you retain first-hand understanding of the core flow
- **Read 2-3 test files** to understand testing patterns and conventions
- **Check build/CI config** to understand how the project is built and tested
- Identify gotchas, non-obvious conventions, and real command patterns from what you read
- Synthesize findings into memory as results come back

**Deep** (100+ tool calls): Everything above, plus:
- Use your TODO or Plan tool to create a systematic research plan
- Use more parallel subagents where helpful to cover additional subsystems
- Deep dive into git history for patterns, conventions, and context
- Analyze commit message conventions and branching strategy
- Read source files across multiple modules to understand architecture thoroughly
- Trace key code paths end-to-end (e.g. how a request flows through the system)
- Read test files to understand what's tested and how
- Identify deprecated code, known issues, and areas of active development
- Create detailed architecture documentation in progressive memory
- May involve multiple rounds of exploration

#### Parallel exploration with subagents

For medium-to-large repos, use the capacity decision from Step 5. Scout inline first (README, manifest/config, top-level directories, entry points) and derive `args.subsystems` from the actual architecture. On the primary Workflow path, load `workflow-authoring` if not already loaded and author a repo-specific script using the contract and repository return shape illustrated in Step 6b. Subagents are read-only, have no memory, and return structured findings; the parent synthesizes them into memory. Set model, effort, timeout, tool budget, and concurrency deliberately.

On the fallback path, launch 2-3 (standard) or 3-5 (deep) `general-purpose` Agent workers concurrently, partitioned by real subsystems. Each self-contained prompt must name the paths and request: key files, abstractions/execution flow, conventions, gotchas/deprecated areas, and paths worth storing. If Agent is unavailable, do the equivalent exploration directly with Bash/Glob/Grep/Read.

Do not sit idle while fan-out runs. Keep first-hand understanding by reading entry points and core flows yourself. When results return, synthesize rather than repeat exploration; for empty Workflow results, inspect its journal first.

#### What to actually read (adapt to the project):

**Source code** (most important — don't skip this):
- Entry points: `main.ts`, `index.ts`, `app.py`, `main.go`, etc.
- Core abstractions: the 3-5 files that define the main domain objects or services
- How key features work: trace at least one feature from entry to implementation
- Test files: understand testing patterns, what's tested, how fixtures work

**Config & metadata**:
- README.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md
- Package manifests (package.json, Cargo.toml, pyproject.toml, go.mod)
- Config files (.eslintrc, tsconfig.json, .prettierrc, biome.json)
- CI/CD configs (.github/workflows/, .gitlab-ci.yml)
- Build scripts and tooling

**Git history**:
- `git log --oneline -20` — recent history
- `git branch -a` — branching strategy
- `git log --format="%s" -50 | head -20` — commit conventions
- `git shortlog -sn --all | head -10` — main contributors
- `git log --format="%an <%ae>" | sort -u` — contributors with emails


### 8. Build memory with discovery paths
As you create/update memory files, add `[[path]]` references so your future self can find related context. These go *inside the content* of memory files:

Do NOT put everything in `system/`. Detailed reference material belongs in progressive memory — files outside `system/` that can be loaded on demand through references.

**Reference external memory from system/ files:**
```markdown
# system/letta-code/overview.md
...
For detailed architecture docs, see [[letta-code/architecture.md]]
Known footguns and edge cases: [[system/letta-code/gotchas.md]]
```

**Reference skills from relevant context:**
```markdown
# system/letta-code/conventions.md
...
When committing, follow the workflow in [[skills/commit]]
For PR creation, use [[skills/review-pr]]
```

**Create an index in overview files:**
```markdown
# system/letta-code/overview.md

CLI for interacting with Letta agents. Bun runtime, React/Ink TUI.

Entry points:
- `src/index.ts` — CLI arg parsing, agent resolution, startup
- `src/cli/App.tsx` — main TUI component (React/Ink)
- `src/agent/` — agent creation, memory, model handling

Key flows:
- Message send: index.ts → App.tsx → agent/message.ts → streaming
- Tool execution: tools/manager.ts → tools/impl/*

Links:
- [[system/letta-code/conventions.md]] — tooling, testing, commits
- [[system/letta-code/gotchas.md]] — common mistakes
- [[letta-code/architecture.md]] — detailed subsystem docs
```

This is a **compact index**, not a prose summary. It tells your future self where to start and where to find more.

Additional guidelines:
- Every file needs a `description` in frontmatter that states its purpose, not a summary of contents
- Keep `system/` files focused and scannable
- Put detailed reference material outside `system/`

### 9. Verify context quality
Before finishing, review your work:

- **Structural requirements**: Run this check before finishing:
  ```bash
  # Detect overlapping file/folder names (e.g. system/human.md AND system/human/)
  find "$MEMORY_DIR" -name "*.md" | sed 's/\.md$//' | while read f; do
    [ -d "$f" ] && echo "VIOLATION: $f.md conflicts with directory $f/"
  done
  ```
  If any violations are printed, fix them before committing (rename `foo.md` → `foo/overview.md` or merge the directory back into the file).
  Also check: Does `system/persona.md` exist? All files have frontmatter with `description`?
- **File granularity**: Does each file cover exactly one focused topic? Do the path and description precisely describe what's inside? If a file mixes multiple concepts (coding style AND git workflow AND communication preferences), split it.
- **Discovery paths**: Are key memory files linked with `[[path]]` so related context can be discovered quickly? Are external files referenced from in-context memory?
- **Project naming**: Are project dirs named after the actual project (e.g., `letta-code/`), not generic `project/`? Same for reference files.
- **Signal density**: Is everything in `system/` truly needed every turn?
- **Persona quality**: Does it express genuine personality and values, not just "agent role + project rules"? Read your persona file right now — if it's just "I'm a coding assistant who follows the user's preferences," that's not identity. What do YOU value? What's distinctive about how you think? Would you be recognizably the same agent on a different model tomorrow? If your persona disappeared but the model stayed, would something meaningful be lost? If not, your identity isn't strong enough yet.
- **No semantic drift**: If reorganizing an existing agent, verify you haven't altered the meaning of persona, identity, or behavioral instructions — only improved structure.
- **No over-pruning**: Compare your final memory against all source material (worker output, codebase research). Did you lose specific file paths, chronic failures, or gotchas during curation? If so, add them back. Compression that loses specificity degrades your identity.
- **Progressive memory**: Did you create reference files outside `system/` for detailed content? Did you review what history workers produced and keep their project context files? Are these files linked from `system/` with `[[path]]` references?


### 10. Ask user if done
Check if they're satisfied or want further refinement. Then commit and push memory:

```bash
cd $MEMORY_DIR
git status                # Review what changed before staging
git add <specific files>  # Stage targeted paths — avoid blind `git add -A`
author_name="${AGENT_NAME:-$AGENT_ID}"
git commit --author="$author_name <$AGENT_ID@letta.com>" -m "feat(init): <summary> ✨

<what was initialized and key decisions made>"

git push
```

## Critical 
**Check capacity before fan-out** — Step 5 decides whether a workflow is affordable; do not skip it.
**Use parallel tool calls wherever possible** — read multiple files in a single turn, write multiple memory files in a single turn. This dramatically reduces init time.
**Write findings to memory as you go** — don't wait until the end.
**Edit memory files directly via the filesystem** — memory is projected to `$MEMORY_DIR` specifically for ease of bulk modification. Use standard file tools (Read, Write, Edit) and git to manage changes during initialization.
