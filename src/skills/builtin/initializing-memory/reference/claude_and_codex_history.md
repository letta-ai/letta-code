# Analyzing Claude Code & Codex Sessions

This guide covers how to analyze historical Claude Code (`~/.claude/`) and OpenAI Codex (`~/.codex/`) session data during `/init`. This is **optional** — only run if the user explicitly approves during upfront questions.

The goal is to extract user personality, preferences, coding patterns, and project context from past sessions and write them into agent memory.

The point is not to produce a thin summary. The point is to extract enough durable detail that future work does not have to rediscover the same user expectations, workflow rules, and project gotchas.

## Prerequisites

- `letta.js` must be built (`bun run build`) — subagents spawn via this binary
- Use `subagent_type: "history-analyzer"` — cheaper model (sonnet), has `bypassPermissions`, creates its own worktree
- The `history-analyzer` subagent has data format docs inlined (Claude/Codex JSONL field mappings, jq queries)

## Step 1: Detect Data and Pre-split Files

```bash
ls ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null
wc -l ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null
```

Split the data across multiple workers for parallel processing — **the more workers, the faster it completes**. Use 2-4+ workers depending on data volume.

**Pre-split the JSONL files by line count** so each worker reads only its chunk:

```bash
SPLIT_DIR=/tmp/history-splits
mkdir -p "$SPLIT_DIR"
NUM_WORKERS=5  # adjust based on data volume

# Split Claude history into even chunks
LINES=$(wc -l < ~/.claude/history.jsonl)
CHUNK_SIZE=$(( LINES / NUM_WORKERS + 1 ))
split -l $CHUNK_SIZE ~/.claude/history.jsonl "$SPLIT_DIR/claude-"

# Split Codex history if it exists
if [ -f ~/.codex/history.jsonl ]; then
  LINES=$(wc -l < ~/.codex/history.jsonl)
  CHUNK_SIZE=$(( LINES / NUM_WORKERS + 1 ))
  split -l $CHUNK_SIZE ~/.codex/history.jsonl "$SPLIT_DIR/codex-"
fi

# Rename to .jsonl for clarity
for f in "$SPLIT_DIR"/*; do mv "$f" "$f.jsonl" 2>/dev/null; done

# Verify even splits
wc -l "$SPLIT_DIR"/*.jsonl
```

This is critical for performance — workers read a small pre-filtered file instead of scanning the full history on every query.

## Step 2: Launch Workers in Parallel

Send all Task calls in **a single message**. Each worker creates its own worktree, reads its pre-split chunk, directly updates memory files, and commits. Workers do NOT merge.

If the worker output is generic, the worker failed. "User is direct" or "project uses TypeScript" is not useful memory unless tied to concrete operational detail.

**IMPORTANT**: Use this prompt template to ensure workers extract all required categories:

```
Task({
  subagent_type: "history-analyzer",
  description: "Process chunk [N] of [SOURCE] history",
  prompt: `## Assignment
- **Memory dir**: [MEMORY_DIR]
- **History chunk**: /tmp/history-splits/[claude-aa.jsonl | codex-aa.jsonl]
- **Source format**: [Claude (.timestamp ms, .display) | Codex (.ts seconds, .text)]
- **Session files**: [~/.claude/projects/ | ~/.codex/sessions/]

## Required Output Categories

You MUST extract findings for ALL THREE categories:

1. **User Personality & Identity**
   - How would you describe them as a person?
   - What drives them? What are their goals?
   - Communication style (beyond "direct" — humor, sarcasm, catchphrases?)
   - Quirks, linguistic patterns, unique attributes

2. **Hard Rules & Preferences**
   - Coding preferences with enforcement evidence (count corrections)
   - Workflow patterns (testing, commits, tools)
   - What frustrates them and why
   - Explicit "always/never" statements

3. **Project Context**
   - Codebase structures, conventions, patterns
   - Gotchas discovered through debugging
   - Which files are safe to edit vs deprecated

If any category lacks data, explicitly state why.

## Required Extraction Dimensions

For each finding, prefer evidence that is:
- repeated across sessions
- tied to a concrete command, file path, or workflow
- useful for future execution without rereading history

You should specifically look for:
1. What the user is building and why it matters to them
2. Correction loops the agent repeatedly got wrong
3. Preferred commands and tooling patterns that were actually used successfully
4. Specific files or directories the user works in or treats as special
5. Project gotchas discovered through debugging or rollback requests

## Canonical Memory Promotion

Promote durable findings into focused files instead of leaving them trapped in generic ingestion notes. Prefer paths like:
- `system/human/identity.md`
- `system/human/prefs/communication.md`
- `system/human/prefs/workflow.md`
- `system/human/prefs/coding.md`
- `system/<project>/conventions.md`
- `system/<project>/gotchas.md`

Avoid generic repo facts unless they influence execution. "Uses TypeScript" is weak. "Uses bun:test, so vitest is wrong for this test suite" is useful.`
})
```

## Step 3: Merge Worker Branches Into Main

After all workers complete, merge their branches one at a time. Worker commits are preserved in git history.

### 3a. Pre-read worker output before merging

Before merging, read each worker's files from their branch to understand what they found. This prevents information loss during conflict resolution:

```bash
cd [MEMORY_DIR]
for branch in $(git branch | grep migration-); do
  echo "=== $branch ==="
  git diff main..$branch --stat
  # Read key files from the branch
  git show $branch:system/human/identity.md  # or equivalent user-identity file
  git show $branch:system/<project>/conventions.md  # or whatever focused files they created
done
```

### 3b. Merge branches one at a time

```bash
cd [MEMORY_DIR]
git merge migration-XXXX --no-edit -m "merge: worker N description"
```

### 3c. Resolve conflicts by COMBINING, never compressing

**CRITICAL**: When resolving merge conflicts, be **additive**. Combine unique details from both sides. Never rewrite a file from scratch — you WILL lose information.

Rules for conflict resolution:
- **Read both sides fully** before editing. Identify what's unique to each version.
- **Append new details** from the incoming branch into the existing file. Don't drop specific quotes, correction counts, file paths, or gotchas just because the existing version already covers the "topic" at a high level.
- **Preserve specificity**: "corrected 5+ times on token counter usage" is more valuable than "prefers factory methods". Keep both.
- **Preserve direct quotes**: User quotes like "wtf crack are you smoking" or "you moron" reveal personality — never summarize these away.
- **When in doubt, keep it**. Redundancy across files is better than information loss. You can always reorganize later.

Example — BAD conflict resolution (compresses):
```
<<<<<<< HEAD
- Uses `uv` for Python
=======
- **Always use `uv run`** — corrected 10+ times for tests and scripts
- `uv run pytest -sv tests/...` for specific tests
- Never use bare `pytest` or `python` commands
>>>>>>> migration-xxx

# BAD: Picks one side or rewrites
- **Python**: `uv` exclusively — `uv run pytest`, never bare `pip`
```

Example — GOOD conflict resolution (combines):
```
# GOOD: Keeps the specific detail from incoming side
- **Python**: `uv` exclusively — corrected 10+ times. `uv run pytest -sv tests/...` for tests, `uv run python` for scripts. Never bare `pip`, `python`, or `pytest`.
```

### 3d. Verify no information was lost

After all merges, compare the final files against what workers produced. Ask yourself: for each worker's output, can I find every specific detail (quotes, file paths, correction counts, gotchas) somewhere in the final memory? If not, add it back.

### 3e. Clean up worktrees and branches

```bash
for w in $(dirname [MEMORY_DIR])/memory-worktrees/migration-*; do
  git worktree remove "$w" 2>/dev/null
done
git branch -d $(git branch | grep migration-)
git push
```

## Example Output

Good output includes all three categories:

```markdown
### User Personality & Identity
Pragmatic builder who values shipping over perfection. Gets frustrated when agents over-engineer or add "bonus" features. Uses dry humor and sarcasm when annoyed. Pattern: "scrappy startup engineer" — wants things to work, not to be architecturally pure.

### Hard Rules & Preferences
- **Use `uv`** for Python — corrected 10+ times ("you need to use uv", "make sure you use uv")
- **Minimal changes only** — "just make a minor change stop adding all this stuff"
- **Only edit specified files** — when told to focus, stay focused
- Tests constantly: `uv run pytest -sv` (Python), `bun test` (TS)

### Project Context
- letta-cloud: Only edit `letta_agent_v2.py` and `letta_agent_v3.py` — others deprecated
- Uses Biome for linting, not ESLint
- Conventional commits with scope in parens
```

## Step 4: Consider Creating Skills From Discovered Workflows

After merging and curating, review the extracted history for repeatable multi-step workflows that would benefit from being codified as skills. History analysis often surfaces procedures the user runs frequently that the agent would otherwise have to rediscover each session.

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

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Subagent exits with code `null`, 0 tool uses | `letta.js` not built | Run `bun run build` |
| Subagent hangs on "Tool requires approval" | Wrong subagent type | Use `subagent_type: "history-analyzer"` (workers) or `"memory"` (synthesis) |
| Merge conflict during synthesis | Workers touched overlapping files | Read both sides fully, combine unique details — never rewrite from scratch. See Step 3c. |
| Information lost after merge | Conflict resolution compressed worker output | Compare final files against each worker's branch output. Re-add missing specifics. See Step 3d. |
| Personality analysis missing or thin | Prompt didn't request it | Use the template above with explicit category requirements |
| Auth fails on push ("repository not found") | Credential helper broken or global helper conflict | Reconfigure **repo-local** helper and check/clear conflicting global `credential.<host>.helper` entries (see syncing-memory-filesystem skill) |
