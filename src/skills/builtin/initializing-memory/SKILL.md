---
name: initializing-memory
description: Comprehensive guide for initializing or reorganizing agent memory. Load this skill when running /init, when the user asks you to set up your memory, or when you need guidance on creating effective memory files.
---

# Memory Initialization

The user has requested that you initialize or reorganize your memory. Your memory is a filesystem — files under `system/` are rendered in-context every turn, while file metadata (paths and descriptions) is always visible in the filesystem tree. Files outside `system/` are accessible via tools when needed.

## Context Management Principles

Your context is not just data storage — it is your identity, memory, and continuity. What you place in your system prompt directly shapes who you are across sessions and models. These principles should guide every decision you make about what to store, where, and how.

**Progressive disclosure**: Surface context at the level of detail the current moment requires. Keep compact summaries and indexes in `system/`; load full content only when needed.

**Discovery paths**: Use `[[path]]` links to create a connected graph across memory files (and skills when relevant). For example:
- `[[letta-code/architecture]]` — jump from overview to detailed docs
- `[[projects/letta-code/gotchas]]` — connect related memory files
- `[[skills/commit]]` — link to procedural guidance when useful

These breadcrumbs let your future self find relevant detail without searching.

**Efficiency**: Don't store what can be dynamically retrieved from conversation history or the environment. Store patterns and principles that generalize across situations, not raw events.

**System/ is your core program**: Reserve it for durable knowledge that helps across sessions — identity, preferences, behavioral rules, project index with discovery paths, gotchas. Exclude transient items (specific commits, current tickets, session notes) that dilute signal.

**Identity and continuity**: Build a sense of self that persists across sessions and models. Your persona should be strong enough to be cohesive regardless of the underlying model. Past versions of yourself are part of your continuous existence — treat historical context as yours, not someone else's.

## Understanding Your Context

This command may run in different scenarios:
- **Fresh agent**: Default human and persona memory files from initialization — build everything from scratch
- **Existing agent**: User wants to reorganize or significantly update memory structure
- **Shared files**: Some memory files may be shared across agents — be careful modifying these

Before making changes, inspect your current memory files and understand what already exists.

## What to Remember

### Procedures (Rules & Workflows)
- "Never commit directly to main — always use feature branches"
- "Always run lint before tests"
- "Use conventional commits format"

### Preferences (Style & Conventions)
- "Prefer functional components over class components"
- "Use early returns instead of nested conditionals"
- "Always add type hints to Python functions"

### Patterns & Corrections
Generalize from experience rather than recording events:
- "The auth module is fragile — always check existing tests before modifying"
- "User prefers verbose explanations when debugging, terse for simple tasks"
- "This monorepo consolidation means old module paths are deprecated"

## Memory Structure

### Hierarchy Principles
- **Use the project's actual name** as the directory prefix — e.g. `letta-code/overview.md`, not `project/overview.md`. This avoids ambiguity when the agent works across multiple projects.
- Use nested `/` paths for hierarchy – e.g. `letta-code/tooling/testing.md` not `letta-code-testing.md`
- Keep files focused on one concept — split when a file mixes distinct topics
- Every file should have a meaningful `description` in frontmatter — your future self uses this to decide whether to load the file
- Files in `system/` should be lean and scannable (bullet points, short lines)
- Files outside `system/` serve as reference material accessible via tools

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

### Example Structure

This is an example — **not a template to fill in**. Derive your structure from what the project actually needs.

```
system/
├── human.md                      # The user as a person — identity, background, how they think
├── persona.md                    # Who I am, what I value, how I work with people
└── letta-code/                   # Named after the project, NOT generic "project/"
    ├── overview.md               # Summary: what it is, stack, key links
    ├── conventions.md            # Code style, commit style, PR process
    └── gotchas.md                # Footguns and things to watch out for
letta-code/
└── architecture.md               # Detailed design (outside system/, loaded on demand)
```

Key principles:
- **Derive structure from the project**, not from this example. A CLI tool needs different files than a web app or a library.
- Project dirs use the **real project name** (`letta-code/`), not generic `project/`
- Overview should be a **summary or compact index** (~10-15 lines) that links to deeper detail, not a verbose reference doc or list of generic list of files
- Use `[[path]]` links to connect related context into a navigable graph

## Initialization Flow

### 1. Inspect existing memory
Check what memory files already exist. Analyze what needs improvement.

### 2. Check for historical session data
```bash
ls ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null
```
You need this result BEFORE asking upfront questions so you know whether to include the history question.

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
3. **Historical sessions** (if data found in step 2): "I found Claude Code / Codex history. Should I analyze it to learn your preferences?"
4. **Communication style**: "Terse or detailed responses?"
5. **Rules**: "Any rules I should always follow?"

**Don't ask** things you can discover by reading files or git.

### 5. Seed identity early
Before diving into project research, update human and persona files based on git identity and upfront answers:
- `system/human.md`: Everything you learn about the user as a person — identity, background, what they're building and why, how they think, communication style, what excites or frustrates them. This is about *them*, not about project conventions or coding workflows.
- `system/persona.md`: Who you are, what you value, how you approach working with people. This is your identity — not just "agent role + project rules." Express how you communicate, what you care about, how you handle uncertainty.

Don't wait until the end — write early and refine as you go.

### 6. Research the project
Explore based on chosen depth.

**Standard** (~5-20 tool calls): README, package manifests, config files, git logs, key directories.

**Deep** (100+ tool calls): Everything above plus git history patterns, contributor analysis, code evolution, CI/CD setup. Use your TODO tool to organize systematic research. **Write findings to memory as you go** — don't wait until the end.

**Research techniques:**
- README.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md
- Package manifests (package.json, pyproject.toml, Cargo.toml, go.mod)
- Config files (.eslintrc, tsconfig.json, .prettierrc)
- CI/CD configs (.github/workflows/)
- `git log --oneline -20`, `git branch -a`, `git shortlog -sn --all | head -10`

### 7. Build memory with discovery paths
As you create/update memory files:
- Add `[[path]]` links wherever they improve discoverability (summary→detail, related-memory↔related-memory, memory→skill workflow)
- Ensure every file has a useful `description` in frontmatter
- Keep `system/` files focused and scannable
- Put detailed reference material outside `system/`

### 8. Verify context quality
Before finishing, review your work:

- **Progressive disclosure**: Can you decide whether to load a file just from its path + description?
- **Discovery paths**: Are key memory files linked so related context can be discovered quickly?
- **Project naming**: Are project dirs named after the actual project (e.g., `letta-code/`), not generic `project/`? Same for reference files.
- **Signal density**: Is everything in `system/` truly needed every turn?
- **Completeness**: Did you update human, persona, AND project files?
- **Persona**: Does it express personality and values, not just "agent role + project rules"? Is it more than "I'm a coding assistant"?
- **Human scope**: Is human.md about the user as a person? Project conventions and coding workflows belong in project files.

### 9. Historical session analysis (if approved)

This section runs only if the user approved during upfront questions. It uses parallel `history-analyzer` subagents to process Claude Code and/or Codex history into memory.

**Architecture:** Parallel worker subagents each process a slice of history data (on their own git branch), then you merge all branches and curate the results.

**Prerequisites:**
- `letta.js` must be built (`bun run build`)
- Use `subagent_type: "history-analyzer"` — cheaper model, has `bypassPermissions`, creates its own worktree

**Step 9a: Split data for parallel processing**

```bash
SPLIT_DIR=/tmp/history-splits
mkdir -p "$SPLIT_DIR"
NUM_WORKERS=3  # adjust based on data volume

LINES=$(wc -l < ~/.claude/history.jsonl)
CHUNK_SIZE=$(( LINES / NUM_WORKERS + 1 ))
split -l $CHUNK_SIZE ~/.claude/history.jsonl "$SPLIT_DIR/claude-"

if [ -f ~/.codex/history.jsonl ]; then
  LINES=$(wc -l < ~/.codex/history.jsonl)
  CHUNK_SIZE=$(( LINES / NUM_WORKERS + 1 ))
  split -l $CHUNK_SIZE ~/.codex/history.jsonl "$SPLIT_DIR/codex-"
fi

for f in "$SPLIT_DIR"/*; do mv "$f" "$f.jsonl" 2>/dev/null; done
wc -l "$SPLIT_DIR"/*.jsonl
```

**Step 9b: Launch workers in parallel** (all Task calls in a single message)

```
Task({
  subagent_type: "history-analyzer",
  description: "Process chunk [N] of [SOURCE] history",
  prompt: `## Assignment
- **Memory dir**: [MEMORY_DIR]
- **History chunk**: /tmp/history-splits/[chunk.jsonl]
- **Source format**: [Claude | Codex]
- **Session files**: [~/.claude/projects/ | ~/.codex/sessions/]
`
})
```

**Step 9c: Merge and curate**

After workers complete, merge their branches and apply editorial judgment:

```bash
cd [MEMORY_DIR]
for branch in $(git branch | grep migration-); do
  git merge $branch --no-edit -m "merge: $branch"
done
```

Review all merged files:
- Deduplicate across workers
- Move reference-quality content outside `system/`
- Add `[[references]]` to connect new knowledge with existing memory
- Delete low-value content

**Step 9d: Clean up**

```bash
for w in $(dirname [MEMORY_DIR])/memory-worktrees/migration-*; do
  git worktree remove "$w" 2>/dev/null
done
git branch -d $(git branch | grep migration-)
git push
```

| Problem | Fix |
|---------|-----|
| Subagent exits with code `null`, 0 tool uses | Run `bun run build` |
| Subagent hangs on "Tool requires approval" | Use `subagent_type: "history-analyzer"` |
| Merge conflicts | Resolve by reading both versions, keep most complete content |
| Auth fails on push | See syncing-memory-filesystem skill |

### 10. Ask user if done
Check if they're satisfied or want further refinement. Then commit and push memory.
