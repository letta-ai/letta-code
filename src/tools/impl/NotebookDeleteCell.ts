import { deleteCell } from "../../notebook/controller.js";
import { validateRequiredParams } from "./validation.js";

interface NotebookDeleteCellArgs {
  notebook_path: string;
  cell_index: number;
}

interface NotebookDeleteCellResult {
  message: string;
}

export async function notebook_delete_cell(
  args: NotebookDeleteCellArgs,
): Promise<NotebookDeleteCellResult> {
  validateRequiredParams(
    args,
    ["notebook_path", "cell_index"],
    "NotebookDeleteCell",
  );
  const { notebook_path, cell_index } = args;

  await deleteCell(notebook_path, cell_index);

  return {
    message: `Deleted cell ${cell_index} from ${notebook_path}.`,
  };
}
