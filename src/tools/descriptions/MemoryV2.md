# Memory
A convenience tool for memories stored in the memory directory (`$MEMORY_DIR`) that automatically commits changes. The harness pushes clean committed memory changes after the turn for remote agents.

Root Markdown files are core memory and are already in the context window. Nested memory stays deferred until it is read through a directory index.

Supported operations on memory files:
- `str_replace`
- `insert`
- `delete` (files, or directories recursively)
- `rename` (path rename only)
- `update_description`
- `create`

For larger reorganizations, edit the projected files directly and commit the changes yourself (see the syncing instructions in your system prompt).

Path formats accepted:
- relative memory file paths (for example, `human.md` or `projects/notes.md`)
- absolute paths only when they are inside `$MEMORY_DIR`

Memory rules:
- Root and child `MEMORY.md` files are frontmatter-free indexes.
- Every other memory Markdown file has exactly `name` and `description` frontmatter.
- A child directory is memory only when it contains `MEMORY.md`.
- `skills/` is managed through skill and file tools, not this tool.
- When creating, renaming, or deleting files, update the nearest `MEMORY.md` index and any affected links.

Examples:

```python
# Replace text in a core memory file
memory(command="str_replace", reason="Update theme preference", file_path="human.md", old_string="theme: dark", new_string="theme: light")

# Create a child directory index
memory(command="create", reason="Index project memory", file_path="projects/MEMORY.md", file_text="# Projects")

# Create a deferred memory file after its directory index exists
memory(command="create", reason="Track project decisions", file_path="projects/decisions.md", description="Decisions for the current project.", file_text="No decisions yet.")

# Update a file description
memory(command="update_description", reason="Clarify project decisions", file_path="projects/decisions.md", description="Accepted and rejected decisions for the current project.")
```
