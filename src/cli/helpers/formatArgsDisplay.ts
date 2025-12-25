// Utility to format tool argument JSON strings into a concise display label
// Copied from old letta-code repo to preserve exact formatting behavior

import { relative } from "node:path";
import {
  isFileEditTool,
  isFileReadTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
} from "./toolNameMapping.js";

// Small helpers
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/**
 * Converts an absolute path to a relative path from cwd.
 * Returns just the filename if in current directory.
 */
function formatRelativePath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  // If it's just a filename (no slashes), return as-is
  // If it starts with .., keep the relative path
  // Otherwise add ./ prefix
  if (!relativePath.includes("/") && !relativePath.includes("\\")) {
    return relativePath;
  }
  if (relativePath.startsWith("..")) {
    return relativePath;
  }
  return `./${relativePath}`;
}

/**
 * Parses a patch input to extract operation type and file path.
 * Returns null if parsing fails.
 */
export function parsePatchInput(
  input: string,
): { kind: "add" | "update" | "delete"; path: string } | null {
  if (!input) return null;

  // Look for the first operation marker
  const addMatch = /\*\*\* Add File:\s*(.+)/.exec(input);
  if (addMatch?.[1]) {
    return { kind: "add", path: addMatch[1].trim() };
  }

  const updateMatch = /\*\*\* Update File:\s*(.+)/.exec(input);
  if (updateMatch?.[1]) {
    return { kind: "update", path: updateMatch[1].trim() };
  }

  const deleteMatch = /\*\*\* Delete File:\s*(.+)/.exec(input);
  if (deleteMatch?.[1]) {
    return { kind: "delete", path: deleteMatch[1].trim() };
  }

  return null;
}

export function formatArgsDisplay(
  argsJson: string,
  toolName?: string,
): {
  display: string;
  parsed: Record<string, unknown>;
} {
  let parsed: Record<string, unknown> = {};
  let display = "…";

  try {
    if (argsJson?.trim()) {
      const p = JSON.parse(argsJson);
      if (isRecord(p)) {
        // Drop noisy keys for display
        const clone: Record<string, unknown> = { ...p } as Record<
          string,
          unknown
        >;
        if ("request_heartbeat" in clone) delete clone.request_heartbeat;
        parsed = clone;

        // Special handling for file tools - show clean relative path
        if (toolName) {
          // Patch tools: parse input and show operation + path
          if (isPatchTool(toolName) && typeof parsed.input === "string") {
            const patchInfo = parsePatchInput(parsed.input);
            if (patchInfo) {
              display = formatRelativePath(patchInfo.path);
              return { display, parsed };
            }
            // Fallback if parsing fails
            display = "…";
            return { display, parsed };
          }

          // Edit tools: show just the file path
          if (isFileEditTool(toolName) && parsed.file_path) {
            const filePath = String(parsed.file_path);
            display = formatRelativePath(filePath);
            return { display, parsed };
          }

          // Write tools: show just the file path
          if (isFileWriteTool(toolName) && parsed.file_path) {
            const filePath = String(parsed.file_path);
            display = formatRelativePath(filePath);
            return { display, parsed };
          }

          // Read tools: show file path + any other useful args (limit, offset)
          if (isFileReadTool(toolName) && parsed.file_path) {
            const filePath = String(parsed.file_path);
            const relativePath = formatRelativePath(filePath);

            // Collect other non-hidden args
            const otherArgs: string[] = [];
            for (const [k, v] of Object.entries(parsed)) {
              if (k === "file_path") continue;
              if (v === undefined || v === null) continue;
              if (typeof v === "boolean" || typeof v === "number") {
                otherArgs.push(`${k}=${v}`);
              } else if (typeof v === "string" && v.length <= 30) {
                otherArgs.push(`${k}="${v}"`);
              }
            }

            if (otherArgs.length > 0) {
              display = `${relativePath}, ${otherArgs.join(", ")}`;
            } else {
              display = relativePath;
            }
            return { display, parsed };
          }

          // Shell/Bash tools: show just the command
          if (isShellTool(toolName) && parsed.command) {
            display = String(parsed.command);
            return { display, parsed };
          }
        }

        // Default handling for other tools
        const keys = Object.keys(parsed);
        const firstKey = keys[0];
        if (
          keys.length === 1 &&
          firstKey &&
          [
            "query",
            "path",
            "file_path",
            "target_file",
            "target_directory",
            "command",
            "label",
            "pattern",
          ].includes(firstKey)
        ) {
          const v = parsed[firstKey];
          display = typeof v === "string" ? v : String(v);
        } else {
          display = Object.entries(parsed)
            .map(([k, v]) => {
              if (v === undefined || v === null) return `${k}=${v}`;
              if (typeof v === "boolean" || typeof v === "number")
                return `${k}=${v}`;
              if (typeof v === "string")
                return v.length > 50 ? `${k}=…` : `${k}="${v}"`;
              if (Array.isArray(v)) return `${k}=[${v.length} items]`;
              if (typeof v === "object")
                return `${k}={${Object.keys(v as Record<string, unknown>).length} props}`;
              const str = JSON.stringify(v);
              return str.length > 50 ? `${k}=…` : `${k}=${str}`;
            })
            .join(", ");
        }
      }
    }
  } catch {
    // Fallback: try to extract common keys without full JSON parse
    try {
      const s = argsJson || "";
      const fp = /"file_path"\s*:\s*"([^"]+)"/.exec(s);
      const old = /"old_string"\s*:\s*"([\s\S]*?)"\s*(,|\})/.exec(s);
      const neu = /"new_string"\s*:\s*"([\s\S]*?)"\s*(,|\})/.exec(s);
      const cont = /"content"\s*:\s*"([\s\S]*?)"\s*(,|\})/.exec(s);
      const parts: string[] = [];
      if (fp) parts.push(`file_path="${fp[1]}"`);
      if (old) parts.push(`old_string=…`);
      if (neu) parts.push(`new_string=…`);
      if (cont) parts.push(`content=…`);
      if (parts.length) display = parts.join(", ");
    } catch {
      // If all else fails, use the ellipsis
    }
  }
  return { display, parsed };
}
