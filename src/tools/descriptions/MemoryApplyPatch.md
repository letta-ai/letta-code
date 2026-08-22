Apply a codex-style patch to memory files in `$MEMORY_DIR`, then automatically commit the change. The harness pushes clean committed memory changes after the turn for remote MemFS agents.

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
- Agent Memory accepts plain Markdown and creates missing directory indexes automatically
- Legacy MemFS updated/deleted files must have valid memory frontmatter
- `read_only: true` files cannot be modified
- In legacy MemFS, adding a file without frontmatter creates frontmatter automatically

Git behavior:
- Stages changed memory paths
- Commits with `reason`
- Uses agent identity author (`<agent_id>@letta.com`)
- Remote MemFS push is handled by the harness after the turn

Example:
```python
memory_apply_patch(
  reason="Refine coding preferences",
  input="""*** Begin Patch
*** Update File: workflow.md
@@
-Use broad abstractions
+Prefer small focused helpers
*** End Patch"""
)
```
