# apply_patch

Applies a patch to the local filesystem using the Codex/Letta ApplyPatch format.

- **input**: Required patch string using the `*** Begin Patch` / `*** End Patch` envelope and per-file sections:
  - `*** Add File: path` followed by one or more `+` lines with the file contents.
  - `*** Update File: path` followed by one or more `@@` hunks where each line starts with a space (` `), minus (`-`), or plus (`+`), representing context, removed, and added lines respectively.
  - `*** Delete File: path` to delete an existing file.
- Paths are interpreted relative to the current working directory.
- The tool validates that each hunk's old content appears in the target file and fails if it cannot be applied cleanly.






