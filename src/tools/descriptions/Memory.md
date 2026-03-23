# Memory
A convinience tool for memories stored in the memory directory (`$MEMORY_DIR`) that automatically commits and pushes changes. 

Files stored inside of `system/` eventually become part of the agent's system prompt, so are always in the context window and do not need to be re-read. Other files only have metadata in the system prompt, so may need to be explicitly read to be updated. 

Supported operations on memory files:  
- `str_replace`
- `insert`
- `delete` (files, or directories recursively)
- `rename` (path rename only)
- `update_description`
- `create`
More general operations can be performanced through directory modifying the files. 

Path formats accepted:
- relative memory file paths (e.g. `system/contacts.md`, `reference/project/team.md`)
- absolute paths only when they are inside `$MEMORY_DIR`

Note: absolute paths outside `$MEMORY_DIR` are rejected.

Examples:

```python
# Replace text in a memory file 
memory(command="str_replace", reason="Update theme preference", path="system/human/preferences.md", old_string="theme: dark", new_string="theme: light")

# Insert text at line 5
memory(command="insert", reason="Add note about meeting", path="reference/history/meeting-notes.md", insert_line=5, insert_text="New note here")

# Delete a memory file 
memory(command="delete", reason="Remove stale notes", path="reference/history/old_notes.md")

# Rename a memory file 
memory(command="rename", reason="Promote temp notes", old_path="reference/history/temp.md", new_path="reference/history/permanent.md")

# Update a block description
memory(command="update_description", reason="Clarify coding prefs block", path="system/human/prefs/coding.md", description="Dr. Wooders' coding preferences.")

# Create a block with starting text
memory(command="create", reason="Track coding preferences", path="system/human/prefs/coding.md", description="The user's coding preferences.", file_text="The user seems to add type hints to all of their Python code.")

# Create an empty block
memory(command="create", reason="Create coding preferences block", path="reference/history/coding_preferences.md", description="The user's coding preferences.")
```
