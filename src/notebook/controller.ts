/**
 * Notebook controller — read, create, edit, delete cells in .ipynb files.
 * Operates directly on the JSON structure without requiring nbformat.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  CellOutput,
  CellSnapshot,
  NotebookCell,
  NotebookDocument,
} from "./types";

function normalizeSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

function sourceToArray(source: string): string[] {
  const lines = source.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

function extractOutputText(outputs: CellOutput[] | undefined): string[] {
  if (!outputs) return [];
  const lines: string[] = [];
  for (const out of outputs) {
    if (out.output_type === "stream") {
      const text = Array.isArray(out.text)
        ? out.text.join("")
        : out.text || "";
      if (text.trim()) lines.push(text.trim());
    } else if (
      out.output_type === "execute_result" ||
      out.output_type === "display_data"
    ) {
      const data = out.data;
      if (data?.["text/plain"]) {
        const text = Array.isArray(data["text/plain"])
          ? data["text/plain"].join("")
          : data["text/plain"];
        if (text.trim()) lines.push(text.trim());
      }
    } else if (out.output_type === "error") {
      if (out.ename && out.evalue) {
        lines.push(`${out.ename}: ${out.evalue}`);
      }
    }
  }
  return lines;
}

function resolvePath(notebookPath: string): string {
  const userCwd = process.env.USER_CWD || process.cwd();
  return path.isAbsolute(notebookPath)
    ? notebookPath
    : path.resolve(userCwd, notebookPath);
}

function getCell(nb: NotebookDocument, index: number): NotebookCell {
  if (index < 0 || index >= nb.cells.length) {
    throw new Error(
      `Cell index ${index} out of range (notebook has ${nb.cells.length} cells)`,
    );
  }
  return nb.cells[index] as NotebookCell;
}

export async function readNotebook(
  notebookPath: string,
): Promise<NotebookDocument> {
  const resolved = resolvePath(notebookPath);
  const content = await fs.readFile(resolved, "utf-8");
  return JSON.parse(content) as NotebookDocument;
}

export async function writeNotebook(
  notebookPath: string,
  notebook: NotebookDocument,
): Promise<void> {
  const resolved = resolvePath(notebookPath);
  await fs.writeFile(resolved, JSON.stringify(notebook, null, 1), "utf-8");
}

export function cellToSnapshot(
  cell: NotebookCell,
  index: number,
): CellSnapshot {
  return {
    index,
    cell_type: cell.cell_type,
    source: normalizeSource(cell.source),
    outputs: extractOutputText(cell.outputs),
    execution_count: cell.execution_count ?? null,
  };
}

export async function readAllCells(
  notebookPath: string,
): Promise<CellSnapshot[]> {
  const nb = await readNotebook(notebookPath);
  return nb.cells.map((cell, i) => cellToSnapshot(cell, i));
}

export async function readCell(
  notebookPath: string,
  index: number,
): Promise<CellSnapshot> {
  const nb = await readNotebook(notebookPath);
  const cell = getCell(nb, index);
  return cellToSnapshot(cell, index);
}

export async function createCell(
  notebookPath: string,
  source: string,
  cellType: "code" | "markdown" | "raw" = "code",
  index?: number,
): Promise<number> {
  const nb = await readNotebook(notebookPath);

  const newCell: NotebookCell = {
    cell_type: cellType,
    source: sourceToArray(source),
    metadata: {},
  };

  if (cellType === "code") {
    newCell.outputs = [];
    newCell.execution_count = null;
  }

  const insertAt =
    index !== undefined
      ? Math.max(0, Math.min(index, nb.cells.length))
      : nb.cells.length;

  nb.cells.splice(insertAt, 0, newCell);
  await writeNotebook(notebookPath, nb);
  return insertAt;
}

export async function editCell(
  notebookPath: string,
  index: number,
  newSource: string,
): Promise<void> {
  const nb = await readNotebook(notebookPath);
  const cell = getCell(nb, index);
  cell.source = sourceToArray(newSource);
  if (cell.cell_type === "code") {
    cell.outputs = [];
    cell.execution_count = null;
  }
  await writeNotebook(notebookPath, nb);
}

export async function editCellByMatch(
  notebookPath: string,
  index: number,
  oldString: string,
  newString: string,
): Promise<{ replacements: number }> {
  const nb = await readNotebook(notebookPath);
  const cell = getCell(nb, index);
  const currentSource = normalizeSource(cell.source);

  if (!oldString && newString) {
    cell.source = sourceToArray(newString);
    await writeNotebook(notebookPath, nb);
    return { replacements: 1 };
  }

  const occurrences = currentSource.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `old_string not found in cell ${index}. Make sure it matches the cell content exactly.`,
    );
  }

  const updated = currentSource.replace(oldString, newString);
  cell.source = sourceToArray(updated);

  if (cell.cell_type === "code") {
    cell.outputs = [];
    cell.execution_count = null;
  }

  await writeNotebook(notebookPath, nb);
  return { replacements: 1 };
}

export async function deleteCell(
  notebookPath: string,
  index: number,
): Promise<void> {
  const nb = await readNotebook(notebookPath);
  getCell(nb, index); // validates index
  nb.cells.splice(index, 1);
  await writeNotebook(notebookPath, nb);
}

export async function getNotebookInfo(
  notebookPath: string,
): Promise<Record<string, unknown>> {
  const nb = await readNotebook(notebookPath);
  return {
    path: resolvePath(notebookPath),
    cell_count: nb.cells.length,
    code_cells: nb.cells.filter((c) => c.cell_type === "code").length,
    markdown_cells: nb.cells.filter((c) => c.cell_type === "markdown").length,
    raw_cells: nb.cells.filter((c) => c.cell_type === "raw").length,
    nbformat: `${nb.nbformat}.${nb.nbformat_minor}`,
    kernel:
      nb.metadata?.kernelspec?.display_name ||
      nb.metadata?.kernelspec?.name ||
      "unknown",
    language: nb.metadata?.language_info?.name || "unknown",
  };
}
