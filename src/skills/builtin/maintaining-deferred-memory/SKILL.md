---
name: maintaining-deferred-memory
description: Maintains an agent's deferred memory, the indexed subdirectories of $MEMORY_DIR that stay out of the system prompt until the agent opens them. Use when saving knowledge about a person, project, repository, system, or incident for later lookup, or when adding, moving, splitting, or indexing memory directories.
---

# Maintaining deferred memory

Deferred memory is Markdown stored in subdirectories of `$MEMORY_DIR`. It costs nothing on turns where the agent does not need it, and the agent loads it progressively: the system prompt shows that a directory exists, the directory's `MEMORY.md` shows what is inside, and the agent reads individual files only when a task calls for them.

## Is this deferred memory?

Letta memory has three tiers. Put each piece of context in the cheapest tier that still works:

| Tier | Location | Visible to the agent | Holds |
|---|---|---|---|
| Core memory | Markdown files directly in `$MEMORY_DIR` | In full on every turn, as part of the system prompt | Identity and the agent's working model of the user and its work, plus the root `MEMORY.md` index |
| Deferred memory | Indexed subdirectories of `$MEMORY_DIR` | Only after the agent opens them | The agent's analysis of a subject, refined over time and looked up when that subject comes up |
| Skill | `$MEMORY_DIR/skills/<name>/SKILL.md` | Name and description every turn; body when loaded | A procedure with a clear trigger |

Two records already exist outside these tiers: message history (recall), which holds every raw event, and the memory repository's git history, which holds every past version of every file. Do not copy either into memory files.

Use deferred memory for understanding of a subject that matters only when that subject comes up. If the agent needs it on most turns, it is core memory: use the `maintaining-core-memory` skill. If it is a procedure with a trigger, use the `creating-skills` skill. `skills/` is reserved for skills and is never deferred memory.

## Check the limits first

Read `$MEMORY_DIR/.memfs.config.json` if it exists. The memory repository's pre-commit hook enforces it:

- `maxDepth` limits how many directories can sit between the memory root and a file (default 2). `persona.md` is depth 0, `projects/MEMORY.md` is depth 1, and `projects/acme/notes.md` is depth 2. `skills/` is exempt.
- `maxFileCharacters` caps each memory file, frontmatter included (default 20,000 characters). `fileCharacterLimits` overrides it per glob; the first match wins and `null` removes the cap.
- `readOnlyFiles` lists globs whose files cannot change. Do not edit them.

When the config file is absent, the defaults apply. When content does not fit, split it into more files or flatten the structure; change the config only when the user asks.

## Layout

```text
$MEMORY_DIR/
├── MEMORY.md              # root index (core memory)
└── projects/
    ├── MEMORY.md          # index for projects/
    ├── acme.md
    └── acme/
        ├── MEMORY.md      # index for projects/acme/
        └── incidents.md
```

- A directory is memory only when it has its own `MEMORY.md`. The agent will not discover a directory without one, and neither will the files in it.
- Every `MEMORY.md` has no frontmatter.
- Every other Markdown file starts with frontmatter containing exactly two fields:

  ```markdown
  ---
  name: acme
  description: How the Acme integration works, why it fails, and what to do about it.
  ---
  ```

- `description` says what the file is about. The agent sees it when it lists the directory, so make it specific enough to decide whether to open the file.
- Name files and directories after their subject, not after a date or session. Group related subjects under one directory instead of creating many top-level directories.

## Write the indexes

Discovery runs through the `MEMORY.md` chain, one level at a time:

- The system prompt lists each top-level memory directory only by path. Add a line to root `MEMORY.md` saying when to open the directory, in the words a future request would use. When a deeper file's topic would not be guessable from that line, name the file there too.
- When the agent opens a directory, it sees that directory's `MEMORY.md`, then each file's `description` and each subdirectory's index summary (the first prose paragraph of its `MEMORY.md`). Start every `MEMORY.md` with that summary paragraph.
- A directory listing shows at most 10 entries, most recently edited first, so stable files fall out of it. Link every file that matters from its `MEMORY.md` rather than relying on the listing.
- Use relative Markdown links from the memory root, such as `[Acme](projects/acme.md)`.

After adding or moving a file, trace the path a future request would take from root `MEMORY.md` to the file. If any step depends on knowing the file already exists, fix the index.

## Design for progressive disclosure

Each level should give the agent enough to decide whether to go deeper, and nothing it would have to read past to decide.

- Put frequently needed material shallow and rarely needed detail deeper. Keep related material in one directory so it loads together.
- A small topic, where most of the content is useful whenever the subject comes up, belongs entirely in its directory's `MEMORY.md`. Splitting it adds reads without saving context.
- For a large topic, `MEMORY.md` holds only what the agent needs every time it opens the directory, plus a map: what each deeper file or subdirectory covers and when it is worth opening. The map should also tell the agent when it can stop.
- A `description` states what the file is about, not when to use it; when-to-open belongs in the parent's link. If you can write a "use when the user wants to…" trigger, the content is a procedure and belongs in a skill.
- Make each statement stand alone. Name the subject instead of writing "it" or "the repo", because the agent may read only part of a file.
- Aim for fewer than 10 entries per directory so the listing stays complete. At the `maxDepth` limit, use clearly scoped sibling files linked from `MEMORY.md` rather than nesting further.

## Write analysis, not logs

Recall already returns what happened. A deferred memory file is worth keeping only when it holds what recall cannot: the agent's own synthesis of a subject, built across many events and refined as understanding improves.

- Before writing, ask whether searching message history would give a future agent the same thing. If it would, do not write the file.
- Write the current understanding: how the subject works, the patterns across events, why things failed or succeeded, what to do about it, and the open questions.
- Revise the file in place when new evidence arrives. Fold the new event into the analysis; never append a dated entry, a quote, or an incident narrative.
- When the file you are updating is already a log, convert it: write the analysis the entries support and delete the entries. Keeping them under an "incident history" heading leaves the log in place; git and recall already hold it.
- When a raw event matters, point to it with terms that will find it in recall rather than copying it.
- Keep one home per subject. Update the existing file instead of adding a near-duplicate, and replace stale conclusions where they live.
- Leave out content the agent can cheaply rederive from the source of truth: file contents, command lists, and current status. Link to the owning source instead.
- Never store secrets. Reference them by name, such as `$SECRET_NAME`.

## Save the change

Changes are saved only once committed. Stage the files you changed, including any updated indexes, by path and commit. The commit message is where lineage lives: what new evidence prompted the revision and how the conclusion changed.

```bash
git -C "$MEMORY_DIR" add <file>... && git -C "$MEMORY_DIR" commit -m "<what changed>" -m "<what prompted it>"
```

`git log -p -- <file>` recovers how the analysis evolved, so the file itself holds only the current understanding.

If the pre-commit hook rejects the commit, fix the reported files and commit again. Do not bypass the hook.
