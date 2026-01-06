import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface EditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
interface EditResult {
  message: string;
  replacements: number;
}

export async function edit(args: EditArgs): Promise<EditResult> {
  validateRequiredParams(
    args,
    ["file_path", "old_string", "new_string"],
    "Edit",
  );
  const { file_path, old_string, new_string, replace_all = false } = args;
  const userCwd = process.env.USER_CWD || process.cwd();
  const resolvedPath = path.isAbsolute(file_path)
    ? file_path
    : path.resolve(userCwd, file_path);
  if (old_string === new_string)
    throw new Error(
      "No changes to make: old_string and new_string are exactly the same.",
    );
  try {
    const rawContent = await fs.readFile(resolvedPath, "utf-8");
    // Normalize line endings to LF for consistent matching (Windows uses CRLF)
    const content = rawContent.replace(/\r\n/g, "\n");
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0)
      throw new Error(
        `String to replace not found in file.\nString: ${old_string}`,
      );
    let newContent: string;
    let replacements: number;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
      replacements = occurrences;
    } else {
      const index = content.indexOf(old_string);
      if (index === -1)
        throw new Error(`String not found in file: ${old_string}`);
      newContent =
        content.substring(0, index) +
        new_string +
        content.substring(index + old_string.length);
      replacements = 1;
    }
    await fs.writeFile(resolvedPath, newContent, "utf-8");

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
      message: `Successfully replaced ${replacements} occurrence${replacements !== 1 ? "s" : ""} in ${resolvedPath}${diagnosticsMessage}`,
      replacements,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `File does not exist. Attempted path: ${resolvedPath}. Current working directory: ${userCwd}`,
      );
    } else if (err.code === "EACCES")
      throw new Error(`Permission denied: ${resolvedPath}`);
    else if (err.code === "EISDIR")
      throw new Error(`Path is a directory: ${resolvedPath}`);
    else if (err.message) throw err;
    else throw new Error(`Failed to edit file: ${err}`);
  }
}
