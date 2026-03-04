import { editCellByMatch } from "../../notebook/controller.js";
import { validateRequiredParams } from "./validation.js";

interface NotebookEditCellArgs {
  notebook_path: string;
  cell_index: number;
  old_string: string;
  new_string: string;
}

interface NotebookEditCellResult {
  message: string;
  replacements: number;
}

export async function notebook_edit_cell(
  args: NotebookEditCellArgs,
): Promise<NotebookEditCellResult> {
  validateRequiredParams(
    args,
    ["notebook_path", "cell_index", "new_string"],
    "NotebookEditCell",
  );
  const { notebook_path, cell_index, old_string, new_string } = args;

  const result = await editCellByMatch(
    notebook_path,
    cell_index,
    old_string || "",
    new_string,
  );

  return {
    message: `Successfully edited cell ${cell_index} in ${notebook_path}.`,
    replacements: result.replacements,
  };
}
