// Utility to format tool argument JSON strings into a concise display label
// Copied from old letta-code repo to preserve exact formatting behavior

import { relative } from "node:path";
import { isRecord } from "@/utils/type-guards";
import {
  type ShellSemanticDisplay,
  summarizeShellDisplay,
} from "./shell-semantic-display.js";
import {
  isFileEditTool,
  isFileReadTool,
  isFileWriteTool,
  isGlobTool,
  isMemoryTool,
  isPatchTool,
  isPlanTool,
  isSearchTool,
  isShellTool,
  isTodoTool,
  isWorkflowTool,
} from "./tool-name-mapping.js";

function formatItemCount(count: number): string {
  return `${String(count)} item${count === 1 ? "" : "s"}`;
}

function formatDisplayPath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  if (relativePath.startsWith("..")) {
    return filePath;
  }
  return relativePath;
}

export function parsePatchInput(
  input: string,
): { kind: "add" | "update" | "delete"; path: string } | null {
  if (!input) return null;

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

export type PatchOperation =
  | { kind: "add"; path: string; content: string; patchLines: string[] }
  | {
      kind: "update";
      path: string;
      oldString: string;
      newString: string;
      patchLines: string[];
    }
  | { kind: "delete"; path: string };

export function parsePatchOperations(input: string): PatchOperation[] {
  if (!input) return [];

  const lines = input.split(/\r?\n/);
  const beginIdx = lines.findIndex((l) => l.trim() === "*** Begin Patch");
  const endIdx = lines.findIndex((l) => l.trim() === "*** End Patch");

  // If no markers, try to parse anyway (some patches might not have them)
  const startIdx = beginIdx === -1 ? 0 : beginIdx + 1;
  const stopIdx = endIdx === -1 ? lines.length : endIdx;

  const operations: PatchOperation[] = [];
  let i = startIdx;

  while (i < stopIdx) {
    const line = lines[i]?.trim();
    if (!line) {
      i++;
      continue;
    }

    if (line.startsWith("*** Add File:")) {
      const path = line.replace("*** Add File:", "").trim();
      i++;
      const contentLines: string[] = [];
      const patchLines: string[] = [];
      while (i < stopIdx) {
        const raw = lines[i];
        if (raw === undefined || raw.startsWith("*** ")) break;
        patchLines.push(raw); // Store raw patch line for direct hunk parsing
        if (raw.startsWith("+")) {
          contentLines.push(raw.slice(1));
        }
        i++;
      }
      operations.push({
        kind: "add",
        path,
        content: contentLines.join("\n"),
        patchLines,
      });
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const path = line.replace("*** Update File:", "").trim();
      i++;

      if (i < stopIdx && lines[i]?.startsWith("*** Move to:")) {
        i++;
      }

      const oldParts: string[] = [];
      const newParts: string[] = [];
      const patchLines: string[] = []; // Store raw lines for direct hunk parsing

      while (i < stopIdx) {
        const hLine = lines[i];
        if (hLine === undefined || hLine.startsWith("*** ")) break;

        patchLines.push(hLine); // Store raw patch line

        if (hLine.startsWith("@@")) {
          // Hunk header - don't parse for oldParts/newParts, just store in patchLines
          i++;
          continue;
        }

        if (hLine === "") {
          // Empty line counts as context
          oldParts.push("");
          newParts.push("");
        } else {
          const prefix = hLine[0];
          const text = hLine.slice(1);

          if (prefix === " ") {
            oldParts.push(text);
            newParts.push(text);
          } else if (prefix === "-") {
            oldParts.push(text);
          } else if (prefix === "+") {
            newParts.push(text);
          }
        }
        i++;
      }

      operations.push({
        kind: "update",
        path,
        oldString: oldParts.join("\n"),
        newString: newParts.join("\n"),
        patchLines,
      });
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const path = line.replace("*** Delete File:", "").trim();
      operations.push({ kind: "delete", path });
      i++;
      continue;
    }

    i++;
  }

  return operations;
}

export function formatArgsDisplay(
  argsJson: string,
  toolName?: string,
  options?: {
    unifiedExecCommandDisplay?: string;
    suppressUnifiedExecInteractionLabel?: boolean;
  },
): {
  display: string;
  displayName?: string;
  parsed: Record<string, unknown>;
  shellSemantic?: ShellSemanticDisplay;
} {
  let parsed: Record<string, unknown> = {};
  let display = "…";
  let shellSemantic: ShellSemanticDisplay | undefined;

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

        if (toolName) {
          if (isPatchTool(toolName) && typeof parsed.input === "string") {
            const patchInfo = parsePatchInput(parsed.input);
            if (patchInfo) {
              display = formatDisplayPath(patchInfo.path);
              return { display, parsed };
            }
            // Fallback if parsing fails
            display = "…";
            return { display, parsed };
          }

          if (isFileEditTool(toolName) && parsed.file_path) {
            const filePath = String(parsed.file_path);
            display = formatDisplayPath(filePath);
            return { display, parsed };
          }

          if (isFileWriteTool(toolName) && parsed.file_path) {
            const filePath = String(parsed.file_path);
            display = formatDisplayPath(filePath);
            return { display, parsed };
          }

          if (isFileReadTool(toolName) && (parsed.file_path || parsed.path)) {
            const filePath = String(parsed.file_path || parsed.path);
            const relativePath = formatDisplayPath(filePath);

            const otherArgs: string[] = [];
            for (const [k, v] of Object.entries(parsed)) {
              if (
                k === "file_path" ||
                k === "path" ||
                k === "offset" ||
                k === "limit"
              )
                continue;
              if (v === undefined || v === null) continue;
              if (typeof v === "boolean" || typeof v === "number") {
                otherArgs.push(`${k}: ${v}`);
              } else if (typeof v === "string" && v.length <= 30) {
                otherArgs.push(`${k}: "${v}"`);
              }
            }

            if (otherArgs.length > 0) {
              display = `${relativePath}, ${otherArgs.join(", ")}`;
            } else {
              display = relativePath;
            }
            return { display, parsed };
          }

          if (isSearchTool(toolName)) {
            const query = String(parsed.query ?? parsed.pattern ?? "");
            const rawPath = parsed.path
              ? String(parsed.path)
              : parsed.file_path
                ? String(parsed.file_path)
                : null;
            // formatDisplayPath returns "" when path is cwd — skip "in" in that case
            const displayPath = rawPath ? formatDisplayPath(rawPath) : null;
            if (query && displayPath) {
              display = `"${query}" in ${displayPath}`;
            } else if (query) {
              display = `"${query}"`;
            } else if (displayPath) {
              display = displayPath;
            }
            return { display, parsed };
          }

          if (isGlobTool(toolName)) {
            const pattern = String(parsed.pattern ?? "");
            const rawPath = parsed.path
              ? String(parsed.path)
              : parsed.file_path
                ? String(parsed.file_path)
                : null;
            // formatDisplayPath returns "" when path is cwd — skip "in" in that case
            const displayPath = rawPath ? formatDisplayPath(rawPath) : null;
            if (pattern && displayPath) {
              display = `${pattern} in ${displayPath}`;
            } else if (pattern) {
              display = pattern;
            } else if (displayPath) {
              display = displayPath;
            }
            return { display, parsed };
          }

          if (isMemoryTool(toolName)) {
            const reason = String(parsed.reason ?? "");
            const filePath = parsed.file_path ? String(parsed.file_path) : null;
            if (reason && filePath) {
              display = `"${reason}" in ${formatDisplayPath(filePath)}`;
            } else if (reason) {
              display = `"${reason}"`;
            } else if (filePath) {
              display = formatDisplayPath(filePath);
            }
            return { display, parsed };
          }

          // Workflow: the script is pages long; show its meta description.
          if (isWorkflowTool(toolName)) {
            const script = String(parsed.script ?? "");
            const description =
              /description\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(script)?.[2];
            display = description
              ? description
              : parsed.scriptPath
                ? formatDisplayPath(String(parsed.scriptPath))
                : "workflow";
            return { display, parsed };
          }

          // TaskOutput (retired; still in saved transcripts): show task id
          // with optional non-blocking marker
          if (toolName.toLowerCase() === "taskoutput" && parsed.task_id) {
            const taskId = String(parsed.task_id);
            const isNonBlocking = parsed.block === false;
            display = isNonBlocking ? `(non-blocking) ${taskId}` : taskId;
            return { display, parsed };
          }

          // write_stdin is part of Codex unified exec: keep it on the shell
          // rendering path, but don't dump raw polling/truncation args in the
          // transcript header.
          if (toolName.toLowerCase() === "write_stdin") {
            const sessionId =
              typeof parsed.session_id === "string" ||
              typeof parsed.session_id === "number"
                ? String(parsed.session_id)
                : "unknown";
            const isWrite =
              typeof parsed.chars === "string" && parsed.chars.length > 0;
            const commandDisplay = options?.unifiedExecCommandDisplay?.trim();
            const suffix = commandDisplay
              ? `· ${commandDisplay}`
              : `(session ${sessionId})`;
            if (options?.suppressUnifiedExecInteractionLabel) {
              return { display: suffix, parsed };
            }
            return {
              display: suffix,
              displayName: isWrite
                ? "Interacted with background terminal"
                : "Checked background terminal",
              parsed,
            };
          }

          // Plan tools: only show compact plan item count.
          if (isPlanTool(toolName) && Array.isArray(parsed.plan)) {
            display = formatItemCount(parsed.plan.length);
            return { display, parsed };
          }

          // Todo tools: only show compact todo item count.
          if (isTodoTool(toolName) && Array.isArray(parsed.todos)) {
            display = formatItemCount(parsed.todos.length);
            return { display, parsed };
          }

          // Shell/Bash tools: show just the command
          if (isShellTool(toolName) && (parsed.command || parsed.cmd)) {
            const commandValue = parsed.cmd ?? parsed.command;
            const description =
              typeof parsed.description === "string"
                ? parsed.description.trim()
                : "";
            shellSemantic = summarizeShellDisplay(
              Array.isArray(commandValue)
                ? commandValue.filter(
                    (part): part is string => typeof part === "string",
                  )
                : String(commandValue),
            );
            display = description || shellSemantic.summary;
            return { display, parsed, shellSemantic };
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
              if (v === undefined || v === null) return `${k}: ${v}`;
              if (typeof v === "boolean" || typeof v === "number")
                return `${k}: ${v}`;
              if (typeof v === "string")
                return v.length > 50 ? `${k}: …` : `${k}: "${v}"`;
              if (Array.isArray(v)) return `${k}: [${v.length} items]`;
              if (typeof v === "object")
                return `${k}: {${Object.keys(v as Record<string, unknown>).length} props}`;
              const str = JSON.stringify(v);
              return str.length > 50 ? `${k}: …` : `${k}: ${str}`;
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
      if (fp) parts.push(`file_path: "${fp[1]}"`);
      if (old) parts.push(`old_string: …`);
      if (neu) parts.push(`new_string: …`);
      if (cont) parts.push(`content: …`);
      if (parts.length) display = parts.join(", ");
    } catch {
      // If all else fails, use the ellipsis
    }
  }
  return { display, parsed, shellSemantic };
}
