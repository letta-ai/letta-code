---
name: maintaining-core-memory
description: Maintains an agent's core memory, the root Markdown files in $MEMORY_DIR that are compiled into its system prompt on every turn. Use when adding, revising, consolidating, or trimming persona, user, project, or root MEMORY.md content, or when folding a correction or preference into the agent's principles.
---

# Maintaining core memory

Every Markdown file directly in `$MEMORY_DIR` is core memory: part of the agent's system prompt, read in full on every turn of every conversation. Each line has a standing cost and shapes every response.

Core memory is the agent's prompt, refined over its lifetime. Treat each change as a revision of that prompt, not an append to a log: the usual edit sharpens, merges, or replaces an existing principle, and a new one earns its place only when no existing one can absorb it.

## Is this core memory?

Letta memory has three tiers. Put each piece of context in the cheapest tier that still works:

| Tier | Location | Visible to the agent | Holds |
|---|---|---|---|
| Core memory | Markdown files directly in `$MEMORY_DIR` | In full on every turn, as part of the system prompt | Identity and the agent's working model of the user and its work, plus the root `MEMORY.md` index |
| Deferred memory | Indexed subdirectories of `$MEMORY_DIR` | Only after the agent opens them | The agent's analysis of a subject, refined over time and looked up when that subject comes up |
| Skill | `$MEMORY_DIR/skills/<name>/SKILL.md` | Name and description every turn; body when loaded | A procedure with a clear trigger |

Two records already exist outside these tiers: message history (recall), which holds every raw event, and the memory repository's git history, which holds every past version of every file. Do not copy either into memory files.

Write to core memory only when the content should change how the agent behaves or what it knows on most turns. Otherwise use the `maintaining-deferred-memory` skill for subject knowledge or the `creating-skills` skill for procedures.

## Check the limits first

Read `$MEMORY_DIR/.memfs.config.json` if it exists. The memory repository's pre-commit hook enforces it:

- `maxCoreMemoryCharacters` caps the total size of all root Markdown (default 65,536 characters).
- `maxFileCharacters` caps each memory file, frontmatter included (default 20,000 characters). `fileCharacterLimits` overrides it per glob; the first match wins and `null` removes the cap.
- `readOnlyFiles` lists globs whose files cannot change. Do not edit them.

When the config file is absent, the defaults apply. Treat the limits as a ceiling, not a target: stay well below them. When an edit does not fit, move detail into deferred memory instead of raising a limit; change the config only when the user asks.

## File format

- Root `MEMORY.md` has no frontmatter.
- Every other root Markdown file starts with frontmatter containing exactly two fields:

  ```markdown
  ---
  name: human
  description: Who the user is and how they want to work together.
  ---
  ```

- The file name becomes the block name in the prompt, so `human.md` renders as `<human>`. Choose short, stable names.
- `description` says what belongs in the file. A future writer uses it to decide what to add here and what to put elsewhere.

## Write principles, not rules

Core memory is the agent's working model: who it is, how the user thinks and what they value, and the principles that follow. It is not a list of rules.

- Treat a correction or preference as evidence about that model. Find the principle it belongs to and sharpen or rewrite that principle. Add a new one only when the evidence shows something the model was missing.
- When several rules share a cause, replace them with the one principle that explains them all, and delete the lines it absorbs in the same edit. Adding the principle while keeping the old rules is a log with a summary on top. A healthy file becomes more general over time; a growing count of narrow rules is a sign of failure.
- State the principle with the reason that makes it generalize: "Verify claims against the running system, because Sarah trusts evidence over plausibility", not three separate rules about tests, logs, and deployments.
- Leave out provenance: no names, dates, quotes, or stories about the incident. Message history already holds the events, and the commit message records why the line changed. When you edit a section that already contains provenance-laden rules, rewrite them as principles; nothing is lost, because git keeps the old text.
- Update only from a pattern or an explicit instruction, not a single ambiguous event.
- Check that a change does not contradict an existing line; resolve the conflict instead of adding both.
- Write in plain language without all-caps or absolute emphasis. Overstated instructions get overapplied.
- Leave out content the agent can cheaply rederive: file contents, command lists, current status, and recent activity.
- Never store secrets. Reference them by name, such as `$SECRET_NAME`.

## Keep root MEMORY.md a map

The root `MEMORY.md` is the agent's map of everything outside core memory. The prompt lists each indexed subdirectory only by path, so the root index is where the agent learns when to open one.

- Give each subdirectory a one-line entry saying when to open it, in the words a future request would use, such as "deployments, rollbacks, on-call runbooks".
- Name a specific deeper file when its topic would not be guessable from the directory entry.
- Do not re-index root files; they are already in core memory.

## Shrink before you grow

When a root file is long or the total is near its limit:

1. Delete stale, duplicated, or rederivable content.
2. Move subject detail into deferred memory and leave a one-line pointer in root `MEMORY.md`.
3. Move procedures into skills.

## Save the change

The edit takes effect only once it is committed, and only in later system prompts; the current conversation keeps the prompt it started with. Stage the files you changed by path and commit. The commit message is where lineage lives: what prompted the change and which lines it replaced or merged.

```bash
git -C "$MEMORY_DIR" add <file>... && git -C "$MEMORY_DIR" commit -m "<what changed>" -m "<what prompted it>"
```

`git log -p -- <file>` recovers the history of any line, so the file itself never needs to carry it.

If the pre-commit hook rejects the commit, fix the reported files and commit again. Do not bypass the hook.
