import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface ApplyPatchArgs {
  input: string;
}

interface ApplyPatchResult {
  message: string;
}

type FileOperation =
  | {
      kind: "add";
      path: string;
      contentLines: string[];
    }
  | {
      kind: "update";
      fromPath: string;
      toPath?: string;
      hunks: Hunk[];
    }
  | {
      kind: "delete";
      path: string;
    };

interface Hunk {
  lines: string[]; // raw hunk lines (excluding the @@ header)
}

/**
 * ApplyPatch implementation compatible with the Letta/Codex apply_patch JSON tool format.
 *
 * Supports:
 * - *** Add File: path
 * - *** Update File: path
 *   - optional *** Move to: new_path
 *   - one or more @@ hunks with space/-/+ lines
 * - *** Delete File: path
 */
export async function apply_patch(
  args: ApplyPatchArgs,
): Promise<ApplyPatchResult> {
  validateRequiredParams(args, ["input"], "apply_patch");
  const { input } = args;

  const lines = input.split(/\r?\n/);
  const beginIndex = lines.findIndex(
    (line) => line.trim() === "*** Begin Patch",
  );
  if (beginIndex !== 0) {
    throw new Error('Patch must start with "*** Begin Patch"');
  }
  const endIndex = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (endIndex === -1) {
    throw new Error('Patch must end with "*** End Patch"');
  }
  for (let tail = endIndex + 1; tail < lines.length; tail += 1) {
    if ((lines[tail] ?? "").trim().length > 0) {
      throw new Error("Unexpected content after *** End Patch");
    }
  }

  const ops: FileOperation[] = [];
  let i = 1;

  while (i < endIndex) {
    const line = lines[i]?.trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (line.startsWith("*** Add File:")) {
      const filePath = line.replace("*** Add File:", "").trim();
      assertRelativePatchPath(filePath, "Add File");
      i += 1;
      const contentLines: string[] = [];
      while (i < endIndex) {
        const raw = lines[i];
        if (raw === undefined || raw.startsWith("*** ")) {
          break;
        }
        if (!raw.startsWith("+")) {
          throw new Error(
            `Invalid Add File line at ${i + 1}: expected '+' prefix`,
          );
        }
        contentLines.push(raw.slice(1));
        i += 1;
      }
      if (contentLines.length === 0) {
        throw new Error(
          `Add File for ${filePath} must include at least one + line`,
        );
      }
      ops.push({ kind: "add", path: filePath, contentLines });
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const fromPath = line.replace("*** Update File:", "").trim();
      assertRelativePatchPath(fromPath, "Update File");
      i += 1;

      let toPath: string | undefined;
      if (i < endIndex) {
        const moveLine = lines[i];
        if (moveLine?.startsWith("*** Move to:")) {
          toPath = moveLine.replace("*** Move to:", "").trim();
          assertRelativePatchPath(toPath, "Move to");
          i += 1;
        }
      }

      const hunks: Hunk[] = [];
      while (i < endIndex) {
        const hLine = lines[i];
        if (hLine === undefined || hLine.startsWith("*** ")) {
          break;
        }
        if (hLine.startsWith("@@")) {
          // Start of a new hunk
          i += 1;
          const hunkLines: string[] = [];
          while (i < endIndex) {
            const l = lines[i];
            if (l === undefined || l.startsWith("@@") || l.startsWith("*** ")) {
              break;
            }
            if (l === "*** End of File") {
              i += 1;
              break;
            }
            if (
              l.startsWith(" ") ||
              l.startsWith("+") ||
              l.startsWith("-") ||
              l === ""
            ) {
              hunkLines.push(l);
            } else {
              throw new Error(
                `Invalid hunk line at ${i + 1}: expected one of ' ', '+', '-'`,
              );
            }
            i += 1;
          }
          hunks.push({ lines: hunkLines });
          continue;
        }
        throw new Error(
          `Invalid Update File body at ${i + 1}: expected '@@' hunk header`,
        );
      }

      if (hunks.length === 0) {
        throw new Error(`Update for file ${fromPath} has no hunks`);
      }

      ops.push({ kind: "update", fromPath, toPath, hunks });
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const filePath = line.replace("*** Delete File:", "").trim();
      assertRelativePatchPath(filePath, "Delete File");
      ops.push({ kind: "delete", path: filePath });
      i += 1;
      continue;
    }

    throw new Error(`Unknown patch directive at line ${i + 1}: ${line}`);
  }

  const cwd = process.env.USER_CWD || process.cwd();
  const pendingWrites = new Map<string, string>();
  const pendingDeletes = new Set<string>();

  // Helper to get current content (including prior ops in this patch)
  const loadFile = async (relativePath: string): Promise<string> => {
    const abs = path.resolve(cwd, relativePath);
    if (pendingDeletes.has(abs)) {
      throw new Error(`File not found for update: ${relativePath}`);
    }
    const cached = pendingWrites.get(abs);
    if (cached !== undefined) return cached;

    try {
      const buf = await fs.readFile(abs, "utf8");
      // Normalize line endings to LF for consistent matching (Windows uses CRLF)
      return buf.replace(/\r\n/g, "\n");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`File not found for update: ${relativePath}`);
      }
      throw err;
    }
  };

  const saveFile = (relativePath: string, content: string) => {
    const abs = path.resolve(cwd, relativePath);
    pendingWrites.set(abs, content);
  };

  // Apply all operations in memory first
  for (const op of ops) {
    if (op.kind === "add") {
      const abs = path.resolve(cwd, op.path);
      if (pendingWrites.has(abs)) {
        throw new Error(`File already added/updated in patch: ${op.path}`);
      }
      if (!(await isMissing(abs))) {
        throw new Error(`Cannot Add File that already exists: ${op.path}`);
      }
      const content = op.contentLines.join("\n");
      pendingWrites.set(abs, content);
    } else if (op.kind === "update") {
      const currentPath = op.fromPath;
      let content = await loadFile(currentPath);

      for (const hunk of op.hunks) {
        content = applyHunk(content, hunk.lines, currentPath);
      }

      const targetPath = op.toPath ?? op.fromPath;
      saveFile(targetPath, content);
      if (op.toPath && op.toPath !== op.fromPath) {
        const oldAbs = path.resolve(cwd, op.fromPath);
        pendingWrites.delete(oldAbs);
        pendingDeletes.add(oldAbs);
      }
    } else if (op.kind === "delete") {
      const abs = path.resolve(cwd, op.path);
      pendingWrites.delete(abs);
      pendingDeletes.add(abs);
    }
  }

  // Flush writes to disk
  for (const [absPath, content] of pendingWrites.entries()) {
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absPath, content, "utf8");
  }

  // Flush deletes after writes (for move semantics)
  for (const absPath of pendingDeletes) {
    if (pendingWrites.has(absPath)) continue;
    if (await isMissing(absPath)) continue;
    await fs.unlink(absPath);
  }

  return {
    message: "Patch applied successfully",
  };
}

function assertRelativePatchPath(patchPath: string, operation: string): void {
  if (!patchPath) {
    throw new Error(`${operation} path cannot be empty`);
  }
  if (path.isAbsolute(patchPath)) {
    throw new Error(
      `${operation} path must be relative (absolute paths are not allowed): ${patchPath}`,
    );
  }
}

async function isMissing(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return false;
  } catch {
    return true;
  }
}

function applyHunk(
  content: string,
  hunkLines: string[],
  filePath: string,
): string {
  const { oldChunk, newChunk } = buildOldNewChunks(hunkLines);
  if (oldChunk.length === 0) {
    throw new Error(
      `Failed to apply hunk to ${filePath}: hunk has no anchor/context`,
    );
  }

  const index = content.indexOf(oldChunk);
  if (index !== -1) {
    return (
      content.slice(0, index) +
      newChunk +
      content.slice(index + oldChunk.length)
    );
  }

  // Handle files that omit trailing newline
  if (oldChunk.endsWith("\n")) {
    const oldWithoutTrailingNewline = oldChunk.slice(0, -1);
    const indexWithoutTrailingNewline = content.indexOf(
      oldWithoutTrailingNewline,
    );
    if (indexWithoutTrailingNewline !== -1) {
      const replacement = newChunk.endsWith("\n")
        ? newChunk.slice(0, -1)
        : newChunk;
      return (
        content.slice(0, indexWithoutTrailingNewline) +
        replacement +
        content.slice(
          indexWithoutTrailingNewline + oldWithoutTrailingNewline.length,
        )
      );
    }
  }

  throw new Error(`Failed to apply hunk to ${filePath}: context not found`);
}

function buildOldNewChunks(lines: string[]): {
  oldChunk: string;
  newChunk: string;
} {
  const oldParts: string[] = [];
  const newParts: string[] = [];

  for (const raw of lines) {
    if (raw === "") {
      oldParts.push("\n");
      newParts.push("\n");
      continue;
    }
    const prefix = raw[0];
    const text = raw.slice(1);

    if (prefix === " ") {
      oldParts.push(`${text}\n`);
      newParts.push(`${text}\n`);
    } else if (prefix === "-") {
      oldParts.push(`${text}\n`);
    } else if (prefix === "+") {
      newParts.push(`${text}\n`);
    }
  }

  return {
    oldChunk: oldParts.join(""),
    newChunk: newParts.join(""),
  };
}
