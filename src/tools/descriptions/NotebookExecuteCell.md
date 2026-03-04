# NotebookExecuteCell

Execute a code cell from a Jupyter notebook and return the output.

Usage:
- `cell_index` is the 0-based index of the cell to execute.
- Only code cells can be executed. Markdown/raw cells are skipped.
- The cell's Python code is executed via `python3`.
- `timeout` is the max execution time in seconds (default: 30).
- Returns stdout, stderr, and success/failure status.
- Note: execution runs in a standalone Python process, not a persistent kernel. Variables from other cells are not available.
- For stateful execution across cells, use the Bash tool with `python3 -c` instead.
