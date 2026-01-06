import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface WriteArgs {
  file_path: string;
  content: string;
}
interface WriteResult {
  message: string;
}

export async function write(args: WriteArgs): Promise<WriteResult> {
  validateRequiredParams(args, ["file_path", "content"], "Write");
  const { file_path, content } = args;
  const userCwd = process.env.USER_CWD || process.cwd();
  const resolvedPath = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(userCwd, file_path);
  try {
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    try {
      const stats = await fs.stat(resolvedPath);
      if (stats.isDirectory())
        throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }
    await fs.writeFile(resolvedPath, content, "utf-8");

    // Notify LSP of the change and get diagnostics
    let diagnosticsMessage = "";
    if (process.env.LETTA_ENABLE_LSP) {
      try {
        const { lspManager } = await import("../../lsp/manager.js");
        await lspManager.touchFile(resolvedPath, true);

        // Wait briefly for diagnostics
        await new Promise((resolve) => setTimeout(resolve, 100));

        const diagnostics = lspManager.getDiagnostics(resolvedPath);
        if (diagnostics.length > 0) {
          const errorCount = diagnostics.filter((d) => d.severity === 1).length;
          const warningCount = diagnostics.filter(
            (d) => d.severity === 2,
          ).length;

          diagnosticsMessage = `\n\n[LSP Diagnostics]\n`;
          if (errorCount > 0)
            diagnosticsMessage += `  ❌ ${errorCount} error(s)\n`;
          if (warningCount > 0)
            diagnosticsMessage += `  ⚠️  ${warningCount} warning(s)\n`;

          // Show first few
          const displayed = diagnostics.slice(0, 3);
          for (const diag of displayed) {
            const icon =
              diag.severity === 1 ? "❌" : diag.severity === 2 ? "⚠️" : "ℹ️";
            const line = diag.range.start.line + 1;
            diagnosticsMessage += `  ${icon} Line ${line}: ${diag.message}\n`;
          }
          if (diagnostics.length > 3) {
            diagnosticsMessage += `  ... and ${diagnostics.length - 3} more\n`;
          }
        } else {
          diagnosticsMessage = "\n\n[LSP Diagnostics]\n  ✓ No issues found";
        }
      } catch {
        // LSP failed, ignore
      }
    }

    return {
      message: `Successfully wrote ${content.length} characters to ${resolvedPath}${diagnosticsMessage}`,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EACCES")
      throw new Error(`Permission denied: ${resolvedPath}`);
    else if (err.code === "ENOSPC")
      throw new Error(`No space left on device: ${resolvedPath}`);
    else if (err.code === "EISDIR")
      throw new Error(`Path is a directory: ${resolvedPath}`);
    else if (err.message) throw err;
    else throw new Error(`Failed to write file: ${err}`);
  }
}
