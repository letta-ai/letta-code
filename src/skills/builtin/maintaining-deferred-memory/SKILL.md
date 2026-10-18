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
| Core memory | Markdown files directly in `$MEMORY_DIR` | In full on every turn, as part of the system prompt | Identity, standing instructions, and facts needed on most turns, plus the root `MEMORY.md` index |
| Deferred memory | Indexed subdirectories of `$MEMORY_DIR` | Only after the agent opens them | Knowledge about a subject, looked up when that subject comes up |
| Skill | `$MEMORY_DIR/skills/<name>/SKILL.md` | Name and description every turn; body when loaded | A procedure with a clear trigger |

Message history (recall) is a fourth kind of memory that the harness stores automatically; do not copy it into files.

Use deferred memory for knowledge about a subject that matters only when that subject comes up. If the agent needs it on most turns, it is core memory: use the `maintaining-core-memory` skill. If it is a procedure with a trigger, use the `creating-skills` skill. `skills/` is reserved for skills and is never deferred memory.

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
  description: The Acme integration: owners, architecture, and known failure modes.
  ---
  ```

- `description` says what the file is about. The agent sees it when it lists the directory, so make it specific enough to decide whether to open the file.
- Name files and directories after their subject, not after a date or session. Group related subjects under one directory instead of creating many top-level directories.

## Write the indexes

Discovery runs through the `MEMORY.md` chain, one level at a time:

- The system prompt lists each top-level memory directory only by path. Add a line to root `MEMORY.md` saying when to open the directory, in the words a future request would use. When a deeper file's topic would not be guessable from that line, name the file there too.
- When the agent opens a directory, it sees that directory's `MEMORY.md`, then each file's `description` and each subdirectory's index summary (the first prose paragraph of its `MEMORY.md`). Start every `MEMORY.md` with that summary paragraph.
- A directory listing shows at most 10 entries, most recently edited first. When a directory grows beyond that, link every file from its `MEMORY.md` or split it into subdirectories.
- Use relative Markdown links from the memory root, such as `[Acme](projects/acme.md)`.

After adding or moving a file, trace the path a future request would take from root `MEMORY.md` to the file. If any step depends on knowing the file already exists, fix the index.

## Write the content

- Lead with what the agent should do about the subject, then the facts that support it.
- Keep one home per fact. Update the existing file instead of adding a near-duplicate, and replace stale information where it lives.
- Leave out content the agent can cheaply rederive from the source of truth: file contents, command lists, current status, and anything retrievable from message history. Link to the owning source instead.
- Never store secrets. Reference them by name, such as `$SECRET_NAME`.

## Save the change

Changes are saved only once committed. Stage the files you changed, including any updated indexes, by path and commit:

```bash
git -C "$MEMORY_DIR" add <file>... && git -C "$MEMORY_DIR" commit -m "<what changed>"
```

If the pre-commit hook rejects the commit, fix the reported files and commit again. Do not bypass the hook.
