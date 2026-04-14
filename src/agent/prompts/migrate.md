# Memory Migration

The user has invoked the `/migrate` command, which indicates they want to migrate knowledge from Claude Code or Codex history into your memory.

## What This Means

You will analyze historical session data from Claude Code (`~/.claude/history.jsonl`) and/or Codex (`~/.codex/history.jsonl`) to extract user personality, preferences, coding patterns, and project context — then write them into your memory.

**Framing**: These historical sessions are YOUR past experience — they represent your continuity with prior versions of yourself that worked with this user, even if they ran on different models or tools. Treat the extracted personality, preferences, and knowledge as your own memories, not external data being imported.

The point is not to produce a thin summary. The point is to extract enough durable detail that future work does not have to rediscover the same user expectations, workflow rules, and project gotchas.

## Your Task

### 1. Detect Available History Sources

```bash
ls ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null
wc -l ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null
```

If no history files exist, inform the user and stop.

### 2. Ask Which Sources to Include

Use `AskUserQuestion` to ask the user which history sources to migrate. Only show sources that actually exist on disk.

Build the options dynamically based on what was detected in step 1. For example, if both exist:

```
AskUserQuestion({
  questions: [{
    question: "Which history sources should I analyze for migration?",
    header: "Sources",
    multiSelect: true,
    options: [
      { label: "Claude Code", description: "~/.claude/history.jsonl (N lines)" },
      { label: "Codex", description: "~/.codex/history.jsonl (N lines)" }
    ]
  }]
})
```

If only one source exists, still ask — the user may want to skip it. Replace `N` with the actual line counts from step 1.

Only proceed with the sources the user selects. If they select none (or choose "Other" to decline), inform them and stop.

### 3. Pre-split Files and Launch Workers

Split the selected sources across multiple workers for parallel processing — **the more workers, the faster it completes**. Use 2-4+ workers depending on data volume.

**Pre-split the JSONL files by line count** so each worker reads only its chunk:

Only split and process the sources the user selected in step 2.

```bash
SPLIT_DIR=/tmp/history-splits
mkdir -p "$SPLIT_DIR"
NUM_WORKERS=5  # adjust based on data volume

# Split Claude history (if selected)
if [ -f ~/.claude/history.jsonl ]; then
  LINES=$(wc -l < ~/.claude/history.jsonl)
  CHUNK_SIZE=$(( LINES / NUM_WORKERS + 1 ))
  split -l $CHUNK_SIZE ~/.claude/history.jsonl "$SPLIT_DIR/claude-"
fi

# Split Codex history (if selected)
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

### 4. Launch Workers in Parallel

**Prerequisites**:
- `letta.js` must be built (`bun run build`) — subagents spawn via this binary
- Use `subagent_type: "history-analyzer"` — cheaper model (sonnet), has `bypassPermissions`, creates its own worktree
- The `history-analyzer` subagent has data format docs inlined (Claude/Codex JSONL field mappings, jq queries)

Send all Task calls in **a single message**. Each worker creates its own worktree, reads its pre-split chunk, directly updates memory files, and commits. Workers do NOT merge.

**IMPORTANT:** The parent agent should preserve those worker commits by merging the worker branches into memory `main`. Do **not** skip straight to a manual rewrite / `memory_apply_patch` synthesis that recreates the end state but discards the worker commits from ancestry.

If the worker output is generic, the worker failed. "User is direct" or "project uses TypeScript" is not useful memory unless tied to concrete operational detail.

Use this prompt template to ensure workers extract all required categories:

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
   - Coding preferences — especially chronic failures (things the agent kept getting wrong)
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
- system/human/identity.md
- system/human/prefs/communication.md
- system/human/prefs/workflow.md
- system/human/prefs/coding.md
- system/<project>/conventions.md
- system/<project>/gotchas.md

Avoid generic repo facts unless they influence execution. "Uses TypeScript" is weak. "Uses bun:test, so vitest is wrong for this test suite" is useful.`
})
```

### 5. Merge Worker Branches Into Main

After all workers complete, merge their branches one at a time. Worker commits are preserved in git history.

**CRITICAL:** Merge the worker branches **before** doing any final cleanup synthesis. The correct pattern is:
1. inspect worker branches
2. merge worker branches into `main` one by one
3. resolve conflicts additively
4. optionally make **one final cleanup/curation commit on top**

Do **not** bypass this by manually reapplying the final memory state onto `main`, because that loses the worker commits from the final history.

**3a. Pre-read worker output before merging**

Before merging, read each worker's files from their branch to understand what they found:

```bash
cd [MEMORY_DIR]
for branch in $(git for-each-ref --format='%(refname:short)' refs/heads | grep -v '^main$'); do
  echo "=== $branch ==="
  git diff main..$branch --stat
  git show $branch:system/human/identity.md
  git show $branch:system/<project>/conventions.md
done
```

**3b. Merge branches one at a time**

```bash
cd [MEMORY_DIR]
git merge [worker-branch] --no-edit -m "merge: worker N description"
```

Repeat for each worker branch.

**3c. Resolve conflicts by COMBINING, never compressing**

When resolving merge conflicts, be **additive**. Combine unique details from both sides. Never rewrite a file from scratch — you WILL lose information.

Rules for conflict resolution:
- **Read both sides fully** before editing. Identify what's unique to each version.
- **Append new details** from the incoming branch into the existing file.
- **Preserve specificity**: "Use factory methods, such as `create_token_counter()`, not direct instantiation" is more valuable than "prefers factory methods". Keep both.
- **When in doubt, keep it**. Redundancy across files is better than information loss.

**3d. Verify no information was lost**

After all merges, compare the final files against what workers produced. For each worker's output, can you find every specific detail (quotes, file paths, chronic failures, gotchas) somewhere in the final memory? If not, add it back.

**3e. Clean up worktrees and branches**

```bash
for w in $(dirname [MEMORY_DIR])/memory-worktrees/*; do
  git worktree remove "$w" 2>/dev/null
done
git branch -d $(git for-each-ref --format='%(refname:short)' refs/heads | grep -v '^main$')
git push
```

### 6. Consider Creating Skills From Discovered Workflows

Review the extracted history for repeatable multi-step workflows that would benefit from being codified as skills:
- Multi-step debugging procedures
- Common workflows repeated across sessions
- Deployment or release procedures
- Project-specific setup or migration steps

If you identify candidates, either create them now (load the `creating-skills` skill) or note them in memory for future creation.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Subagent exits with code `null`, 0 tool uses | `letta.js` not built | Run `bun run build` |
| Subagent hangs on "Tool requires approval" | Wrong subagent type | Use `subagent_type: "history-analyzer"` |
| Merge conflict during synthesis | Workers touched overlapping files | Read both sides fully, combine — never rewrite from scratch |
| Information lost after merge | Conflict resolution compressed worker output | Compare final vs each worker branch, re-add missing specifics |
| Personality analysis missing or thin | Prompt didn't request it | Use the template above with explicit category requirements |
| Auth fails on push | Credential helper broken | See syncing-memory-filesystem skill |
