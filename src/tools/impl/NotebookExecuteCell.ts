import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readCell } from "../../notebook/controller.js";
import { validateRequiredParams } from "./validation.js";

const execAsync = promisify(exec);

interface NotebookExecuteCellArgs {
  notebook_path: string;
  cell_index: number;
  timeout?: number;
}

interface NotebookExecuteCellResult {
  message: string;
}

export async function notebook_execute_cell(
  args: NotebookExecuteCellArgs,
): Promise<NotebookExecuteCellResult> {
  validateRequiredParams(
    args,
    ["notebook_path", "cell_index"],
    "NotebookExecuteCell",
  );
  const { notebook_path, cell_index, timeout } = args;

  const cell = await readCell(notebook_path, cell_index);

  if (cell.cell_type !== "code") {
    return {
      message: `Cell ${cell_index} is a ${cell.cell_type} cell — nothing to execute.`,
    };
  }

  const code = cell.source;
  const timeoutMs = (timeout || 30) * 1000;

  try {
    const { stdout, stderr } = await execAsync(
      `python3 -c ${JSON.stringify(code)}`,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );

    const parts: string[] = [`Executed cell ${cell_index}. Success: true`];
    if (stdout.trim()) {
      parts.push(`Output:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`Stderr:\n${stderr.trim()}`);
    }
    if (!stdout.trim() && !stderr.trim()) {
      parts.push("(no output)");
    }

    return { message: parts.join("\n") };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      message?: string;
    };

    if (err.killed) {
      return {
        message: `Execution of cell ${cell_index} timed out after ${timeout || 30}s.`,
      };
    }

    const parts: string[] = [`Executed cell ${cell_index}. Success: false`];
    if (err.stdout?.trim()) {
      parts.push(`Output:\n${err.stdout.trim()}`);
    }
    if (err.stderr?.trim()) {
      parts.push(`Error:\n${err.stderr.trim()}`);
    } else if (err.message) {
      parts.push(`Error:\n${err.message}`);
    }

    return { message: parts.join("\n") };
  }
}
