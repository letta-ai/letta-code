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
3. **Historical sessions** (if data found in step 2): "I found historical coding-agent sessions (name the sources detected, e.g. Claude Code / Codex). Should I analyze them to learn your preferences?" Say that approving means read-only subagents on your current model will read those transcripts, so the user can make an informed choice.
4. **Communication style**: "Terse or detailed responses?"

**Don't ask** things you can discover by reading files, git, or history analysis. Rules and preferences should be learned from observation, not asked upfront.

### 5. Prepare the history inventory (if approved)

This is **optional** — only run if the user explicitly approved analyzing historical sessions during upfront questions. Skip entirely if they chose "Skip"; the code research in Step 6 still runs.

**Framing**: These historical sessions are YOUR past experience — they represent your continuity with prior versions of yourself that worked with this user, even if they ran on different models or tools. Treat the extracted personality, preferences, and knowledge as your own memories, not external data being imported.

The goal is to extract user personality, preferences, coding patterns, and project context from past sessions — in enough detail that future work does not have to rediscover the same user expectations, workflow rules, and project gotchas. A thin summary is a failure.

#### 5a. Export all historical sessions into one directory

`letta trajectories export` discovers every native session store on this machine (via the trajectory package's `listTrajectories`), normalizes each session (via `normalizeTranscript` / `normalizeCheckpoint`) into one shared record format, and writes everything into a single directory. Harnesses supported by the installed trajectory package are picked up automatically — no per-source handling here.

```bash
letta trajectories export --out /tmp/letta-trajectories

# Review what was exported and the time span it covers
jq '{sessions: (.sessions | length), sources, errors: (.errors | length), from: .sessions[0].startedAt, to: .sessions[-1].startedAt}' /tmp/letta-trajectories/manifest.json
```

This produces:
- `/tmp/letta-trajectories/<source>/<startedAt>_<sessionId>.json` — one normalized trajectory per session (a single-line JSON array); filenames sort chronologically, and the `sessionId` (a stable hash of the source-scoped native session id) does not change across re-exports
- `/tmp/letta-trajectories/manifest.json` — index with per-session metadata (`sessionId`, native `id`, `file`, `project`, dates, `userMessages`, `bytes`, first prompt), sorted by `startedAt`, plus `errors` for sessions that failed to normalize

**The manifest is the authoritative inventory.** Every session in `.sessions` must end up either analyzed or explicitly excluded with a reason; every entry in `.errors` counts as not analyzed.

Useful variations:
- `--project $(pwd)` — filters by pathname prefix, not directory boundary; inspect the manifest for similarly named sibling projects (e.g. `letta-code-internal` when filtering `letta-code`)
- `--source claude-code --source codex` — restrict sources
- `--root <source>:<path>` — read a source's store from a non-standard location
- `--transcript <source>:<path>` — also normalize an explicit transcript file (e.g. copied from another machine)

To browse the export yourself (all source-agnostic):
- `letta trajectories list` — sessions with dates, sources, and first prompts
- `letta trajectories view <file|sessionId> [--tools] [--reasoning]` — one session as a readable conversation
- `letta trajectories search <keyword> [--role user]` — search message content across all sessions

#### 5b. Render and cohort the sessions

```bash
node <SKILL_DIR>/scripts/prepare-history.mjs --export /tmp/letta-trajectories --out /tmp/letta-init-history
```

This renders every session to plain text with `letta trajectories view --tools` (workflow subagents only have Read/Grep/Glob), groups each project's sessions into chronological cohorts of roughly 200 KB / 20 sessions (`--max-bytes`, `--max-sessions`), and writes the files below. If `letta` is not on PATH, pass the command that runs it with `--letta "<command>"`. Outputs:
- `cohorts.json` — `{ historyCohorts: [{ id, repo, sessions: [{ sessionId, path, source, project, startedAt, userMessages }] }] }` with absolute paths; `repo` is the session project if it still exists on disk
- `ledger.json` — manifest total, export errors, and every excluded session with its reason (no user messages, render failure)

You may reshape `cohorts.json` before the Workflow — merge small cohorts, or in standard mode drop low-value sessions (one-prompt, no corrections). Anything you drop is reported as not analyzed in Step 8, so tell the user.

### 6. Research the codebase

**IMPORTANT**: The goal is to understand how the codebase actually works — not just its shape, but its substance. By the end of initialization, you should be able to describe how a key feature flows from entry point to implementation. If you can't, you haven't read enough.

Start first-hand: the README and agent docs (AGENTS.md, CLAUDE.md), the package manifest, entry points, and recent git history. Keep reading key implementation and test files yourself so you retain real understanding — the Workflow supplements your research, it does not replace it. Delegate breadth: split a large repository into subsystem areas for Step 7, and include related repos the user named in Step 4. A small codebase may need no delegation at all.

In deep mode, go further: more areas, git history for conventions and active areas, end-to-end tracing of key flows, and detailed architecture notes in progressive memory outside `system/`. Use your TODO or Plan tool to track the research plan.

### 7. Run the analysis Workflow

Running /init with this skill **authorizes one Workflow run** for read-only analysis of the approved history cohorts and the code areas (plus a follow-up run for unread cohorts, Step 8). It does not authorize anything else: history cohorts are included only with the user's consent from Step 4, and workflow subagents never write memory, create worktrees, or edit the repository.

Load the `workflow-authoring` skill and design the script for this repository and history. Whatever shape you choose, it must:
- **Stay read-only.** Leave subagent tools at the default (Read/Grep/Glob).
- **Give each subagent complete context.** Workflow subagents have no memory, skills, or view of this conversation. Pass `historyCohorts` from `cohorts.json` and your code areas through the tool's `args`, and put the user's identity, the repository path, and absolute file paths in every prompt.
- **Return `sessionsRead`.** Each history subagent must read every session in its cohort and return JSON that includes `sessionsRead`: the `sessionId`s it finished. Step 8 counts coverage from this field alone.
- **Ask for evidence-backed specifics.** User identity and personality, hard rules and preferences, corrections (what the agent did, what the user said, what resolved it, how often it repeated), project conventions and gotchas — each with session ids and excerpts. Harness-injected text such as `<system-reminder>` blocks is not the user's own words. Never copy secrets.
- **Check code claims against current code.** History describes the code as it was. Verify claims about a cohort's `repo` against the current tree (for example a verify stage chained after each history agent) and report what changed.
- **Budget time for reading.** Subagents time out after 10 minutes by default; raise `timeoutMs` for history agents that read large cohorts.

If the Workflow tool is unavailable (it is not in your toolset, or it reports that workflow subagents require the API backend), do the same analysis yourself, cohort by cohort and area by area, and account for coverage against `cohorts.json` and `ledger.json` by hand. Do not substitute other subagent types that write memory.

The Workflow runs in the background. **Do not wait idle**: keep reading core code yourself and start drafting identity, persona, and project memory. Its result arrives as a task notification; never assume results before it does.

### 8. Curate workflow results into memory

You — not the workflow subagents — decide what becomes memory and write it.

**8a. Check coverage first.** The tool result names the run's `journal.jsonl`:

```bash
node <SKILL_DIR>/scripts/history-coverage.mjs --prepared /tmp/letta-init-history \
  --journal ~/.letta/workflows/executions/<id>/journal.jsonl \
  --retry-out /tmp/letta-init-history/retry.json
```

It reports sessions analyzed, unread (assigned but missing from every `sessionsRead`), excluded, export errors, and any dropped from `cohorts.json`, and writes unread sessions as smaller cohorts to `retry.json`. For failed agents, the journal records which guard or error fired. Runs are not resumable: launch one follow-up Workflow over `retry.json`, then rerun the script with both `--journal` paths. If coverage is still incomplete, say so plainly — how many sessions were analyzed out of the manifest total and which ranges were not — and never describe the result as comprehensive. Note unanalyzed ranges in progressive memory outside `system/` so a later pass can pick them up.

**8b. Weigh validation.** Code claims confirmed against current code can be stored as fact. For stale claims, store the current fact, or keep the history as a dated note only when the change itself is a useful gotcha. Claims that could not be checked need your own check before they go into always-in-context memory. User preferences and personality are not code-checkable; weigh them by repetition and how strongly the user reacted.

**8c. Combine across cohorts, never compress.** Different cohorts often report the same topic at different specificity. Merge them additively:
- Keep unique details from every cohort. Don't drop specific quotes, file paths, correction counts, or gotchas because another cohort already covered the "topic" at a high level.
- **Preserve specificity**: "Use factory methods, such as `create_token_counter()`, not direct instantiation" is more valuable than "prefers factory methods". Keep both.
- Sum correction counts across cohorts; a correction seen in five cohorts is a chronic failure.
- **When in doubt, keep it**. Redundancy across files is better than information loss. Less important details can be placed in progressive memory outside `system/`.

Example — BAD combination (compresses):
```
# cohort A found:
- Uses `uv` for Python
# cohort B found:
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

**8d. Promote into canonical memory.** Write findings into the focused files from the structure guidance above (for example `system/human/identity.md`, `system/human/prefs/workflow.md`, `system/<project>/conventions.md`, `system/<project>/gotchas.md`), with evidence detail in progressive memory outside `system/`. Avoid generic repo facts unless they influence execution. "Uses TypeScript" is weak. "Uses bun:test, so vitest is wrong for this test suite" is useful. If the combined output is generic, the analysis failed for that area — re-read the relevant transcripts or code yourself.

Good curated output covers all three categories:

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

**8e. Consider creating skills from discovered workflows.** Review the findings for repeatable multi-step workflows that would benefit from being codified as skills. History analysis often surfaces procedures the user runs frequently that the agent would otherwise have to rediscover each session.

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

#### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Workflow tool missing, or it reports workflow subagents require the API backend | Workflow is unavailable in this environment | Do the cohort and area analysis yourself, tracking which sessions in `cohorts.json` you read, and report coverage against `ledger.json` |
| A cohort or area came back `null` | Timeout, tool-call guard, non-JSON reply, or other subagent failure | Read the run's `journal.jsonl`; a failed history cohort's sessions land in `retry.json`, and failed code areas go in the same follow-up run |
| Sessions reported as unread by `history-coverage.mjs` | Cohort too large, or the subagent omitted `sessionsRead` | Run one follow-up Workflow over the generated `retry.json` |
| `letta trajectories export` reports errors in manifest.json | Degenerate sessions (e.g. no assistant turns) that cannot form a valid trajectory | Expected — those sessions are skipped; list them in the ledger and review `jq .errors manifest.json` only if counts look wrong |
| `deepagents` sessions fail to normalize | Checkpoint decoding needs a Python environment with LangGraph installed | Expected on machines without it; the failures land in manifest errors and other sources are unaffected |
| Findings are generic or reference the wrong repo | The prompt lacked context (subagents see nothing but their prompt) | Put absolute paths, the user identity, and the project in `args` and prompts |
| Information lost after curation | Curation compressed findings | Re-read the workflow results and compare against final files. Re-add missing specifics. |
| Personality analysis missing or thin | Cohorts were mostly one-prompt sessions, or the prompt omitted the category | Reprioritize interaction-heavy sessions; keep all categories in the prompt |
| Auth fails on push ("repository not found") | Credential helper broken or global helper conflict | Reconfigure **repo-local** helper and check/clear conflicting global `credential.<host>.helper` entries (see syncing-memory-filesystem skill) |

### 9. Build memory with discovery paths
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

### 10. Verify context quality
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
- **No over-pruning**: Compare your final memory against all source material (workflow results, your own codebase research). Did you lose specific file paths, chronic failures, or gotchas during curation? If so, add them back. Compression that loses specificity degrades your identity.
- **Progressive memory**: Did you create reference files outside `system/` for detailed content? Did you keep the detailed project context and evidence from the workflow results? Are these files linked from `system/` with `[[path]]` references?


### 11. Ask user if done
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
**Use parallel tool calls wherever possible** — read multiple files in a single turn, write multiple memory files in a single turn. This dramatically reduces init time.
**Write findings to memory as you go** — don't wait until the end.
**Edit memory files directly via the filesystem** — memory is projected to `$MEMORY_DIR` specifically for ease of bulk modification. Use standard file tools (Read, Write, Edit) and git to manage changes during initialization.
