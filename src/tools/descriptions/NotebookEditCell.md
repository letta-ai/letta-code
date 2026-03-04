# NotebookEditCell

Edit a cell in a Jupyter notebook using find-and-replace within the cell.

Usage:
- `cell_index` is 0-based.
- `old_string` is the text to find in the cell. It must match exactly (whitespace-sensitive).
- `new_string` is the replacement text.
- If `old_string` is empty, the entire cell content is replaced with `new_string`.
- Only the first occurrence of `old_string` is replaced.
- The edit will fail if `old_string` is not found in the cell.
- Code cell outputs are cleared after editing (they need re-execution).
