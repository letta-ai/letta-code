import { getCurrentWorkingDirectory } from "@/runtime-context";
import { read as baseRead, type ToolReturnContent } from "./read.js";

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
  content: ToolReturnContent;
}

export async function read_lsp(args: ReadLSPArgs): Promise<ReadLSPResult> {
  const result = await baseRead(args);

  // Skip LSP if not enabled (shouldn't happen since we only load this when enabled)
  if (!process.env.LETTA_ENABLE_LSP) {
    return result;
  }

  // If content is multimodal (image), skip LSP processing - only applies to text files
  if (typeof result.content !== "string") {
    return result;
  }

  const lineCount = result.content.split("\n").length;
  const shouldInclude =
    args.include_types === true ||
    (args.include_types !== false && lineCount < 500);

  if (!shouldInclude) {
    return result;
  }

  try {
    const { lspManager } = await import("@/lsp/manager.js");
    const path = await import("node:path");

    const userCwd = getCurrentWorkingDirectory();
    const resolvedPath = path.default.isAbsolute(args.file_path)
      ? args.file_path
      : path.default.resolve(userCwd, args.file_path);

    await lspManager.touchFile(resolvedPath, false);

    // Wait briefly for diagnostics (LSP servers are async)
    await new Promise((resolve) => setTimeout(resolve, 100));

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

    return result;
  } catch (_error) {
    // If LSP fails, silently return the base result
    return result;
  }
}
