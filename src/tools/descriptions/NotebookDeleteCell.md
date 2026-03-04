# NotebookDeleteCell

Delete a cell from a Jupyter notebook.

Usage:
- `cell_index` is the 0-based index of the cell to delete.
- The cell is permanently removed from the notebook.
- All subsequent cells shift down by one index.
- Use NotebookRead first to verify you're deleting the correct cell.
