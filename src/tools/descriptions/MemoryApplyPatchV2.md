Apply a codex-style patch to memory files in `$MEMORY_DIR`, then automatically commit the change. The harness pushes clean committed memory changes after the turn for remote agents.

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
- Relative paths are interpreted inside the memory repository.
- Absolute paths are allowed only when under `$MEMORY_DIR`.
- Paths outside the memory repository are rejected.

Memory rules:
- Root and child `MEMORY.md` files are frontmatter-free indexes.
- Every other memory Markdown file has exactly `name` and `description` frontmatter.
- A child directory is memory only when it contains `MEMORY.md`.
- `skills/` is managed through skill and file tools, not this tool.
- Adding a regular memory file without frontmatter creates valid frontmatter automatically.

Git behavior:
- Stages changed memory paths.
- Commits with `reason`.
- Uses the agent identity as the author (`<agent_id>@letta.com`).
- Remote memory push is handled by the harness after the turn.

Example:
```python
memory_apply_patch(
  reason="Refine coding preferences",
  input="""*** Begin Patch
*** Update File: human.md
@@
-Use broad abstractions
+Prefer small focused helpers
*** End Patch"""
)
```
