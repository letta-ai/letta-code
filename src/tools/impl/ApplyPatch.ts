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
 * Simple ApplyPatch implementation compatible with the Letta/Codex apply_patch tool format.
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
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new Error('Patch must start with "*** Begin Patch"');
  }
  const endIndex = lines.lastIndexOf("*** End Patch");
  if (endIndex === -1) {
    throw new Error('Patch must end with "*** End Patch"');
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
      i += 1;
      const contentLines: string[] = [];
      while (i < endIndex && !lines[i].startsWith("*** ")) {
        const raw = lines[i];
        if (raw.startsWith("+")) {
          contentLines.push(raw.slice(1));
        }
        i += 1;
      }
      ops.push({ kind: "add", path: filePath, contentLines });
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const fromPath = line.replace("*** Update File:", "").trim();
      i += 1;

      let toPath: string | undefined;
      if (i < endIndex && lines[i].startsWith("*** Move to:")) {
        toPath = lines[i].replace("*** Move to:", "").trim();
        i += 1;
      }

      const hunks: Hunk[] = [];
      while (i < endIndex && !lines[i].startsWith("*** ")) {
        const hLine = lines[i];
        if (hLine.startsWith("@@")) {
          // Start of a new hunk
          i += 1;
          const hunkLines: string[] = [];
          while (
            i < endIndex &&
            !lines[i].startsWith("@@") &&
            !lines[i].startsWith("*** ")
          ) {
            const l = lines[i];
            if (
              l.startsWith(" ") ||
              l.startsWith("+") ||
              l.startsWith("-") ||
              l === ""
            ) {
              hunkLines.push(l);
            }
            i += 1;
          }
          hunks.push({ lines: hunkLines });
          continue;
        }
        // Skip stray lines until next header/hunk
        i += 1;
      }

      if (hunks.length === 0) {
        throw new Error(`Update for file ${fromPath} has no hunks`);
      }

      ops.push({ kind: "update", fromPath, toPath, hunks });
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const filePath = line.replace("*** Delete File:", "").trim();
      ops.push({ kind: "delete", path: filePath });
      i += 1;
      continue;
    }

    // Unknown directive; skip
    i += 1;
  }

  const cwd = process.cwd();
  const pendingWrites = new Map<string, string>();

  // Helper to get current content (including prior ops in this patch)
  const loadFile = async (relativePath: string): Promise<string> => {
    const abs = path.resolve(cwd, relativePath);
    const cached = pendingWrites.get(abs);
    if (cached !== undefined) return cached;

    try {
      const buf = await fs.readFile(abs, "utf8");
      return buf;
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
      const content = op.contentLines.join("\n");
      pendingWrites.set(abs, content);
    } else if (op.kind === "update") {
      const currentPath = op.fromPath;
      let content = await loadFile(currentPath);

      for (const hunk of op.hunks) {
        const { oldChunk, newChunk } = buildOldNewChunks(hunk.lines);
        if (!oldChunk) {
          continue;
        }
        const idx = content.indexOf(oldChunk);
        if (idx === -1) {
          throw new Error(
            `Failed to apply hunk to ${currentPath}: context not found`,
          );
        }
        content =
          content.slice(0, idx) + newChunk + content.slice(idx + oldChunk.length);
      }

      const targetPath = op.toPath ?? op.fromPath;
      saveFile(targetPath, content);
      // If file was renamed, also clear the old path so we don't write both
      if (op.toPath && op.toPath !== op.fromPath) {
        const oldAbs = path.resolve(cwd, op.fromPath);
        if (pendingWrites.has(oldAbs)) {
          pendingWrites.delete(oldAbs);
        }
      }
    }
  }

  // Apply deletes on disk
  for (const op of ops) {
    if (op.kind === "delete") {
      const abs = path.resolve(cwd, op.path);
      try {
        await fs.unlink(abs);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  // Flush writes to disk
  for (const [absPath, content] of pendingWrites.entries()) {
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absPath, content, "utf8");
  }

  return {
    message: "Patch applied successfully",
  };
}

function buildOldNewChunks(lines: string[]): { oldChunk: string; newChunk: string } {
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
      oldParts.push(text + "\n");
      newParts.push(text + "\n");
    } else if (prefix === "-") {
      oldParts.push(text + "\n");
    } else if (prefix === "+") {
      newParts.push(text + "\n");
    }
  }

  return {
    oldChunk: oldParts.join(""),
    newChunk: newParts.join(""),
  };
}









