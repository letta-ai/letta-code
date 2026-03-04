# NotebookCreateCell

Create a new cell in a Jupyter notebook.

Usage:
- `source` is the cell content (Python code or Markdown text).
- `cell_type` is one of: "code", "markdown", "raw". Defaults to "code".
- `cell_index` is where to insert (0-based). If omitted, the cell is appended to the end.
- For code cells, outputs and execution_count are initialized as empty.
- Write clean, well-structured code. Add markdown cells for explanations.
