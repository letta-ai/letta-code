# Memory
A convenience tool for memories stored in the memory directory (`$MEMORY_DIR`) that automatically commits changes. The harness pushes clean committed memory changes after the turn for remote MemFS agents.

Root Markdown files other than `MEMORY.md` eventually become part of the agent's system prompt, so are always in the context window and do not need to be re-read. Files in indexed child directories remain deferred until explicitly read.

Supported operations on memory files:
- `str_replace`
- `insert`
- `delete` (files, or directories recursively)
- `rename` (path rename only)
- `update_description`
- `create`
For larger reorganizations, edit the projected files directly and commit the changes yourself (see the syncing instructions in your system prompt).

Path formats accepted:
- relative memory file paths (e.g. `contacts.md`, `reference/project/team.md`)
- absolute paths only when they are inside `$MEMORY_DIR`

Note: absolute paths outside `$MEMORY_DIR` are rejected.

When creating or deleting files, check for ordinary relative Markdown links from `MEMORY.md` files that may need to be added or updated. Keeping references consistent ensures future discoverability.

Memory rules:
- Root and child `MEMORY.md` files are frontmatter-free indexes.
- Every other memory Markdown file has exactly `name` and `description` frontmatter.
- A child directory is memory only when it contains `MEMORY.md`.

Examples:

```python
# Replace text in a memory file
memory(command="str_replace", reason="Update theme preference", file_path="human-preferences.md", old_string="theme: dark", new_string="theme: light")

# Insert text at line 5
memory(command="insert", reason="Add note about meeting", file_path="history/meeting-notes.md", insert_line=5, insert_text="New note here")

# Delete a memory file
memory(command="delete", reason="Remove stale notes", file_path="history/old_notes.md")

# Rename a memory file
memory(command="rename", reason="Promote temp notes", old_path="history/temp.md", new_path="history/permanent.md")

# Update a block description
memory(command="update_description", reason="Clarify coding prefs block", file_path="human-prefs-coding.md", description="The user's coding preferences.")

# Create a block with starting text
memory(command="create", reason="Track coding preferences", file_path="human-prefs-coding.md", description="The user's coding preferences.", file_text="The user seems to add type hints to all of their Python code.")

# Create an empty block
memory(command="create", reason="Create coding preferences block", file_path="reference/history/coding_preferences.md", description="The user's coding preferences.")
```
