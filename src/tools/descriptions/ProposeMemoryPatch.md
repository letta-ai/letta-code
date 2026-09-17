# Propose Memory Patch

Apply a Codex-style patch to the harness-owned memory-writer worktree. This tool drafts files only — it does **not** commit, push, or merge.

The patch must stay inside `$MEMORY_DIR` / `LETTA_MEMORY_DIR` (the current worktree). Reuse the same patch DSL as `apply_patch`:

```
*** Begin Patch
*** Add File: path/to/file.md
+contents
*** End Patch
```

Operations: Add File, Update File, Delete File, Move File. Context lines in update hunks must match exactly.

`reason` is a short description of the semantic change. The harness uses it when committing after validation.

Do not include `.git` paths. Do not mark files `read_only: true`. Keep required memory frontmatter valid.
