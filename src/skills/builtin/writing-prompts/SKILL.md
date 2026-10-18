---
name: writing-prompts
description: Writes and edits an agent's root memory files, the Markdown in the top level of $MEMORY_DIR that is compiled into its system prompt on every turn. Use when adding, revising, consolidating, or trimming persona, user, project, or root MEMORY.md content, or when turning a correction or preference into a standing instruction.
---

# Writing prompts

Every Markdown file directly in `$MEMORY_DIR` is part of the agent's system prompt. The agent reads it in full on every turn, in every conversation, so each line has a standing cost and shapes every response. Writing these files is writing the agent's prompt.

## Is this prompt material?

Letta memory has three tiers. Put each piece of context in the cheapest tier that still works:

| Tier | Location | Visible to the agent | Holds |
|---|---|---|---|
| Prompt | Markdown files directly in `$MEMORY_DIR` | In full on every turn | Identity, standing instructions, and facts needed on most turns, plus the root `MEMORY.md` index |
| Deferred memory | Indexed subdirectories of `$MEMORY_DIR` | Only after the agent opens them | Knowledge about a subject, looked up when that subject comes up |
| Skill | `$MEMORY_DIR/skills/<name>/SKILL.md` | Name and description every turn; body when loaded | A procedure with a clear trigger |

Message history (recall) is a fourth kind of memory that the harness stores automatically; do not copy it into files.

Write to the prompt only when the content should change how the agent behaves or what it knows on most turns. Otherwise use the `writing-deferred-memory` skill for subject knowledge or the `creating-skills` skill for procedures.

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

## Write instructions, not notes

- Write to the agent in the second person or imperative mood: "Lead with the answer", not "The user likes answers first".
- Generalize a correction into the rule it implies, and keep the user's exact wording when the wording itself is the constraint. Do not log the incident that produced it.
- Prefer one decisive rule over a list of examples or caveats. Add an example only when the rule is ambiguous without it.
- Keep one home per fact. Update or replace the existing line instead of appending a near-duplicate.
- Leave out content the agent can cheaply rederive: file contents, command lists, current status, recent activity, and anything retrievable from message history.
- Never store secrets. Reference them by name, such as `$SECRET_NAME`.

## Keep root MEMORY.md a map

The root `MEMORY.md` is the agent's map of everything outside the prompt. The prompt lists each indexed subdirectory only by path, so the root index is where the agent learns when to open one.

- Give each subdirectory a one-line entry saying when to open it, in the words a future request would use, such as "deployments, rollbacks, on-call runbooks".
- Name a specific deeper file when its topic would not be guessable from the directory entry.
- Do not re-index root files; they are already in the prompt.

## Shrink before you grow

When a root file is long or the total is near its limit:

1. Delete stale, duplicated, or rederivable content.
2. Move subject detail into deferred memory and leave a one-line pointer in root `MEMORY.md`.
3. Move procedures into skills.

## Save the change

The edit takes effect only once it is committed, and only in later prompts; the current conversation keeps the prompt it started with. Stage the files you changed by path and commit:

```bash
git -C "$MEMORY_DIR" add <file>... && git -C "$MEMORY_DIR" commit -m "<what changed>"
```

If the pre-commit hook rejects the commit, fix the reported files and commit again. Do not bypass the hook.
