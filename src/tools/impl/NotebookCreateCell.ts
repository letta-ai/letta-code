import { createCell } from "../../notebook/controller.js";
import { validateRequiredParams } from "./validation.js";

interface NotebookCreateCellArgs {
  notebook_path: string;
  source: string;
  cell_type?: "code" | "markdown" | "raw";
  cell_index?: number;
}

interface NotebookCreateCellResult {
  message: string;
}

export async function notebook_create_cell(
  args: NotebookCreateCellArgs,
): Promise<NotebookCreateCellResult> {
  validateRequiredParams(args, ["notebook_path", "source"], "NotebookCreateCell");
  const { notebook_path, source, cell_type, cell_index } = args;

  const insertedAt = await createCell(
    notebook_path,
    source,
    cell_type || "code",
    cell_index,
  );

  return {
    message: `Created ${cell_type || "code"} cell at index ${insertedAt} in ${notebook_path}.`,
  };
}
