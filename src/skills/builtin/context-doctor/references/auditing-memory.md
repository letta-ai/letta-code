# Auditing memory

A broken link, missing index, or conflicting instruction is direct evidence;
no conversation incident or provider trace is required to diagnose it.

Start with the target memory directory's file inventory, core memory, indexes,
and `letta memory tokens --memory-dir <path> --format json --quiet`. Inspect
relevant file contents and links to check:

- **Structure:** required files, frontmatter, skill layout, and overlapping
  file/directory names against the active memory format below.
- **Organization:** duplicate or contradictory facts/instructions, stale content,
  and filenames or descriptions that misrepresent a file's purpose.
- **Discoverability:** broken links, missing index entries, and external memory
  with no useful discovery path from core memory. Follow links to verify their
  targets and the context in which they would be retrieved. Skills are discovered
  through their catalog and metadata too; a missing core-memory link alone does
  not establish that a skill is unavailable.
- **Core-memory size:** which files dominate the estimate, whether detail is
  duplicated or misplaced, and what must remain in context to guide behavior.

Use bounded inventories and targeted reads for large stores; expand coverage
when the requested audit needs it. State which directories and checks were
covered. Conversation history can help resolve a stale fact or explain a
retrieval failure, but is not a prerequisite for reporting structural defects.

Respect the supplied memory format:

- **memfs-v1** (including local): `system/` contains core memory, including
  `system/persona.md`; external memory is outside it and uses `[[path]]` links.
  Memory Markdown requires nonempty `description` frontmatter. Only
  `description`, legacy `limit`, and protected `read_only` fields are allowed;
  `name` belongs to skill metadata, not v1 memory frontmatter.
- **memfs-v2**: root Markdown is core memory, including `MEMORY.md` and
  `persona.md`. Root/child `MEMORY.md` indexes have no frontmatter; other memory
  Markdown has exactly `name` and `description`. Child memory directories need
  `MEMORY.md` indexes with ordinary relative Markdown links.
- **No memory filesystem:** report that file-structure checks are unavailable;
  investigate accessible context and behavior within the requested scope.

Both formats use `skills/<name>/SKILL.md` with a nonempty `name` in frontmatter.
Skills have their own metadata rules and do not require memory-directory indexes;
do not apply memory frontmatter rules to skill resources.
Do not create overlapping file/directory names such as `human.md` and `human/`.

## Repair and verify

For the current agent's memory, use the normal memory-editing workflow in its
memory directory. Other conversations may be working on that same memory:
inspect `git status` and current files first.
A different target agent does not share this memory directory;
identify its authoritative store before proposing or applying a repair.

Fix stale facts at their source, resolve contradictions and redundant content,
repair malformed skill metadata, correct discovery links, or improve a faulty
skill step.

Treat core-memory size as one signal. Roughly 10% of context is a soft guideline,
not a quota to enforce. Preserve useful rationale, examples, persona, and user
preferences. Make proportional edits only when evidence supports them; smaller
memory alone is not proof of improved behavior.

Moving detail behind a link changes when it reaches the model. Keep essential
instructions and cues for when to retrieve that detail in core memory; a link
alone does not preserve their in-context effect.

Review the diff and validate changed file structure and links. Follow the
ordinary memory commit/sync workflow; doctor has no separate worktree or
completion-time integration step. If there are no supported fixes, make no commit.

After a repair, recheck the original structural or content defect and any
affected links or indexes.
