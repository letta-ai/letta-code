# Memory
A convenience tool for memories stored in the memory directory (`$MEMORY_DIR`) that automatically commits changes. The harness pushes clean committed memory changes after the turn for remote MemFS agents.

The active system prompt explains which files are core memory and which files are deferred. Inspect the current memory projection before choosing a path. The tool preserves and validates the active memory format.

Supported operations on memory files:  
- `str_replace`
- `insert`
- `delete` (files, or directories recursively)
- `rename` (path rename only)
- `update_description`
- `create`
For larger reorganizations, edit the projected files directly and commit the changes yourself (see the syncing instructions in your system prompt).

Path formats accepted:
- relative memory file paths (e.g. `reference/project/team.md`)
- absolute paths only when they are inside `$MEMORY_DIR`

Note: absolute paths outside `$MEMORY_DIR` are rejected.

When creating, renaming, or deleting files, update the indexes and links required by the active memory format.

Examples:

```python
# Replace text in a memory file 
memory(command="str_replace", reason="Update meeting outcome", file_path="reference/history/meeting-notes.md", old_string="status: open", new_string="status: resolved")

# Insert text at line 5
memory(command="insert", reason="Add note about meeting", file_path="reference/history/meeting-notes.md", insert_line=5, insert_text="New note here")

# Delete a memory file 
memory(command="delete", reason="Remove stale notes", file_path="reference/history/old_notes.md")

# Rename a memory file 
memory(command="rename", reason="Promote temp notes", old_path="reference/history/temp.md", new_path="reference/history/permanent.md")

# Update a file description
memory(command="update_description", reason="Clarify meeting notes", file_path="reference/history/meeting-notes.md", description="Decisions from recurring project meetings.")

# Create an empty block
memory(command="create", reason="Create coding preferences block", file_path="reference/history/coding_preferences.md", description="The user's coding preferences.")
```
