/**
 * LSP-enhanced Read tool - wraps the base Read tool and adds LSP diagnostics
 * This is used when LETTA_ENABLE_LSP is set
 */
import { read as baseRead } from "./Read.js";

// Format a single diagnostic in opencode style: "ERROR [line:col] message"
function formatDiagnostic(diag: {
  severity?: number;
  range: { start: { line: number; character: number } };
  message: string;
}): string {
  const severityMap: Record<number, string> = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  };
  const severity = severityMap[diag.severity || 1] || "ERROR";
  const line = diag.range.start.line + 1; // Convert to 1-based
  const col = diag.range.start.character + 1;
  return `${severity} [${line}:${col}] ${diag.message}`;
}

interface ReadLSPArgs {
  file_path: string;
  offset?: number;
  limit?: number;
  include_types?: boolean;
}

interface ReadLSPResult {
  content: string;
}

export async function read_lsp(args: ReadLSPArgs): Promise<ReadLSPResult> {
  // First, call the base read function
  const result = await baseRead(args);

  // Skip LSP if not enabled (shouldn't happen since we only load this when enabled)
  if (!process.env.LETTA_ENABLE_LSP) {
    return result;
  }

  // Determine if we should include diagnostics
  const lineCount = result.content.split("\n").length;
  const shouldInclude =
    args.include_types === true ||
    (args.include_types !== false && lineCount < 500);

  if (!shouldInclude) {
    return result;
  }

  try {
    // Import LSP manager dynamically
    const { lspManager } = await import("../../lsp/manager.js");
    const path = await import("node:path");

    // Resolve the path
    const userCwd = process.env.USER_CWD || process.cwd();
    const resolvedPath = path.default.isAbsolute(args.file_path)
      ? args.file_path
      : path.default.resolve(userCwd, args.file_path);

    // Touch the file (opens it in LSP if not already open)
    await lspManager.touchFile(resolvedPath, false);

    // Wait briefly for diagnostics (LSP servers are async)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get diagnostics
    const diagnostics = lspManager.getDiagnostics(resolvedPath);

    if (diagnostics.length > 0) {
      // Only show errors (severity 1) like opencode does
      const errors = diagnostics.filter((d) => d.severity === 1);
      if (errors.length === 0) {
        return result;
      }

      const maxDiagnostics = 10;
      const displayed = errors.slice(0, maxDiagnostics);
      const suffix =
        errors.length > maxDiagnostics
          ? `\n... and ${errors.length - maxDiagnostics} more`
          : "";

      return {
        content: `${result.content}\n\nThis file has errors, please fix\n<file_diagnostics>\n${displayed.map(formatDiagnostic).join("\n")}${suffix}\n</file_diagnostics>`,
      };
    }

    // No errors - return as-is
    return result;
  } catch (_error) {
    // If LSP fails, silently return the base result
    return result;
  }
}
