# NotebookRead

Read cells from a Jupyter notebook (.ipynb file).

Usage:
- Use `notebook_path` to specify the notebook file.
- Omit `cell_index` to read all cells. Provide it to read a single cell.
- Each cell is shown with its index, type (code/markdown/raw), and source.
- Code cell outputs are included by default. Set `include_outputs` to false to hide them.
- Cell indices are 0-based.
- This tool works on any .ipynb file — the notebook does not need a running kernel.
