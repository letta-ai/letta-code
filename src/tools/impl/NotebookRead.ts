import { readAllCells, readCell } from "../../notebook/controller.js";
import { validateRequiredParams } from "./validation.js";

interface NotebookReadArgs {
  notebook_path: string;
  cell_index?: number;
  include_outputs?: boolean;
}

interface NotebookReadResult {
  content: string;
}

export async function notebook_read(
  args: NotebookReadArgs,
): Promise<NotebookReadResult> {
  validateRequiredParams(args, ["notebook_path"], "NotebookRead");
  const { notebook_path, cell_index, include_outputs } = args;
  const showOutputs = include_outputs !== false;

  if (cell_index !== undefined) {
    const cell = await readCell(notebook_path, cell_index);
    let result = `[Cell ${cell.index}] (${cell.cell_type})`;
    if (cell.execution_count !== null) {
      result += ` [${cell.execution_count}]`;
    }
    result += `\n${cell.source}`;
    if (showOutputs && cell.outputs.length > 0) {
      result += `\n── Output ──\n${cell.outputs.join("\n")}`;
    }
    return { content: result };
  }

  const cells = await readAllCells(notebook_path);
  if (cells.length === 0) {
    return { content: "(empty notebook)" };
  }

  const parts: string[] = [];
  for (const cell of cells) {
    let header = `[Cell ${cell.index}] (${cell.cell_type})`;
    if (cell.execution_count !== null) {
      header += ` [${cell.execution_count}]`;
    }
    parts.push(`${header}\n${cell.source}`);
    if (showOutputs && cell.outputs.length > 0) {
      parts.push(`── Output ──\n${cell.outputs.slice(0, 5).join("\n")}`);
    }
  }

  return { content: parts.join("\n\n") };
}
