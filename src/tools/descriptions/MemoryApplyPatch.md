Apply a codex-style patch to memory files in `$MEMORY_DIR`, then automatically commit and push the change.

This is similar to `apply_patch`, but scoped to the memory filesystem and with memory-aware guardrails.

- Required args:
  - `reason` — git commit message for the memory change
  - `input` — patch text using the standard apply_patch format

Patch format:
- `*** Begin Patch`
- `*** Add File: <path>`
- `*** Update File: <path>`
  - optional `*** Move to: <path>`
  - one or more `@@` hunks with ` `, `-`, `+` lines
- `*** Delete File: <path>`
- `*** End Patch`

Path rules:
- Relative paths are interpreted inside memory repo
- Absolute paths are allowed only when under `$MEMORY_DIR`
- Paths outside memory repo are rejected

Memory rules:
- Operates on markdown memory files (`.md`)
- Updated/deleted files must be valid memory files with frontmatter
- `read_only: true` files cannot be modified
- If adding a file without frontmatter, frontmatter is created automatically

Git behavior:
- Stages changed memory paths
- Commits with `reason`
- Uses agent identity author (`<agent_id>@letta.com`)
- Pushes to remote

Example:
```python
memory_apply_patch(
  reason="Refine coding preferences",
  input="""*** Begin Patch
*** Update File: system/human/prefs/coding.md
@@
-Use broad abstractions
+Prefer small focused helpers
*** End Patch"""
)
```
