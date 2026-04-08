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
      toPath: string | null;
      chunks: UpdateChunk[];
    }
  | {
      kind: "delete";
      path: string;
    };

interface UpdateChunk {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

interface AffectedPaths {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * ApplyPatch implementation compatible with Codex apply_patch semantics.
 */
export async function apply_patch(
  args: ApplyPatchArgs,
): Promise<ApplyPatchResult> {
  validateRequiredParams(args, ["input"], "apply_patch");
  const { input } = args;

  const operations = parsePatch(input);
  if (operations.length === 0) {
    throw new Error("No files were modified.");
  }

  const cwd = process.env.USER_CWD || process.cwd();
  const affected: AffectedPaths = { added: [], modified: [], deleted: [] };

  for (const op of operations) {
    if (op.kind === "add") {
      const targetPath = resolvePatchPath(cwd, op.path);
      const parent = path.dirname(targetPath);
      if (parent) {
        await fs.mkdir(parent, { recursive: true });
      }

      const content = op.contentLines.join("\n");
      await fs.writeFile(targetPath, content, "utf8");
      affected.added.push(op.path);
      continue;
    }

    if (op.kind === "delete") {
      const targetPath = resolvePatchPath(cwd, op.path);
      try {
        await fs.unlink(targetPath);
      } catch {
        throw new Error(`Failed to delete file ${op.path}`);
      }
      affected.deleted.push(op.path);
      continue;
    }

    const sourcePath = resolvePatchPath(cwd, op.fromPath);
    const newContents = await deriveNewContentsFromChunks(
      sourcePath,
      op.fromPath,
      op.chunks,
    );

    if (op.toPath && op.toPath !== op.fromPath) {
      const destinationPath = resolvePatchPath(cwd, op.toPath);
      const parent = path.dirname(destinationPath);
      if (parent) {
        await fs.mkdir(parent, { recursive: true });
      }

      try {
        await fs.writeFile(destinationPath, newContents, "utf8");
      } catch {
        throw new Error(`Failed to write file ${op.toPath}`);
      }

      try {
        await fs.unlink(sourcePath);
      } catch {
        throw new Error(`Failed to remove original ${op.fromPath}`);
      }

      affected.modified.push(op.toPath);
    } else {
      try {
        await fs.writeFile(sourcePath, newContents, "utf8");
      } catch {
        throw new Error(`Failed to write file ${op.fromPath}`);
      }

      affected.modified.push(op.fromPath);
    }
  }

  return {
    message: formatSummary(affected),
  };
}

function formatSummary(affected: AffectedPaths): string {
  const lines: string[] = ["Success. Updated the following files:"];
  for (const filePath of affected.added) {
    lines.push(`A ${filePath}`);
  }
  for (const filePath of affected.modified) {
    lines.push(`M ${filePath}`);
  }
  for (const filePath of affected.deleted) {
    lines.push(`D ${filePath}`);
  }
  return lines.join("\n");
}

function parsePatch(input: string): FileOperation[] {
  const normalized = normalizePatchInput(input);
  const lines = normalized.split(/\r?\n/);

  checkPatchBoundaries(lines);

  const operations: FileOperation[] = [];
  const endIndex = lines.length - 1;
  let index = 1;

  while (index < endIndex) {
    const rawLine = lines[index] ?? "";
    const firstLine = rawLine.trim();

    if (!firstLine) {
      index += 1;
      continue;
    }

    if (firstLine.startsWith(ADD_FILE_MARKER)) {
      const filePath = firstLine.slice(ADD_FILE_MARKER.length);
      assertPatchPath(filePath, "Add File");

      index += 1;
      const contentLines: string[] = [];
      while (index < endIndex) {
        const addLine = lines[index] ?? "";
        if (!addLine.startsWith("+")) {
          break;
        }

        contentLines.push(addLine.slice(1));
        index += 1;
      }

      operations.push({ kind: "add", path: filePath, contentLines });
      continue;
    }

    if (firstLine.startsWith(DELETE_FILE_MARKER)) {
      const filePath = firstLine.slice(DELETE_FILE_MARKER.length);
      assertPatchPath(filePath, "Delete File");
      operations.push({ kind: "delete", path: filePath });
      index += 1;
      continue;
    }

    if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
      const fromPath = firstLine.slice(UPDATE_FILE_MARKER.length);
      assertPatchPath(fromPath, "Update File");

      index += 1;
      let toPath: string | null = null;
      const maybeMoveLine = lines[index] ?? "";
      if (maybeMoveLine.startsWith(MOVE_TO_MARKER)) {
        toPath = maybeMoveLine.slice(MOVE_TO_MARKER.length);
        assertPatchPath(toPath, "Move to");
        index += 1;
      }

      const chunks: UpdateChunk[] = [];
      let allowMissingContext = true;

      while (index < endIndex) {
        const chunkStart = lines[index] ?? "";

        if (!chunkStart.trim()) {
          index += 1;
          continue;
        }

        if (chunkStart.startsWith("***")) {
          break;
        }

        const parsed = parseUpdateChunk(
          lines,
          index,
          endIndex,
          allowMissingContext,
        );
        chunks.push(parsed.chunk);
        index = parsed.nextIndex;
        allowMissingContext = false;
      }

      if (chunks.length === 0) {
        throw new Error(`Update file hunk for path '${fromPath}' is empty`);
      }

      operations.push({ kind: "update", fromPath, toPath, chunks });
      continue;
    }

    throw new Error(
      `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    );
  }

  return operations;
}

function parseUpdateChunk(
  lines: string[],
  startIndex: number,
  endIndex: number,
  allowMissingContext: boolean,
): { chunk: UpdateChunk; nextIndex: number } {
  let index = startIndex;
  const firstLine = lines[index] ?? "";

  let changeContext: string | null = null;
  if (firstLine === EMPTY_CHANGE_CONTEXT_MARKER) {
    index += 1;
  } else if (firstLine.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = firstLine.slice(CHANGE_CONTEXT_MARKER.length);
    index += 1;
  } else if (!allowMissingContext) {
    throw new Error(
      `Expected update hunk to start with a @@ context marker, got: '${firstLine}'`,
    );
  }

  if (index >= endIndex) {
    throw new Error("Update hunk does not contain any lines");
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let parsedLineCount = 0;

  while (index < endIndex) {
    const line = lines[index] ?? "";

    if (line === EOF_MARKER) {
      if (parsedLineCount === 0) {
        throw new Error("Update hunk does not contain any lines");
      }

      isEndOfFile = true;
      parsedLineCount += 1;
      index += 1;
      break;
    }

    if (line.length === 0) {
      oldLines.push("");
      newLines.push("");
      parsedLineCount += 1;
      index += 1;
      continue;
    }

    const prefix = line[0];
    if (prefix === " ") {
      const text = line.slice(1);
      oldLines.push(text);
      newLines.push(text);
      parsedLineCount += 1;
      index += 1;
      continue;
    }

    if (prefix === "+") {
      newLines.push(line.slice(1));
      parsedLineCount += 1;
      index += 1;
      continue;
    }

    if (prefix === "-") {
      oldLines.push(line.slice(1));
      parsedLineCount += 1;
      index += 1;
      continue;
    }

    if (parsedLineCount === 0) {
      throw new Error(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }

    break;
  }

  return {
    chunk: {
      changeContext,
      oldLines,
      newLines,
      isEndOfFile,
    },
    nextIndex: index,
  };
}

function normalizePatchInput(input: string): string {
  const lines = input.trim().split(/\r?\n/);

  if (passesBoundaryCheck(lines)) {
    return lines.join("\n");
  }

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];

  const isHeredocEnvelope =
    (firstLine === "<<EOF" ||
      firstLine === "<<'EOF'" ||
      firstLine === '<<"EOF"') &&
    typeof lastLine === "string" &&
    lastLine.endsWith("EOF") &&
    lines.length >= 4;

  if (!isHeredocEnvelope) {
    return lines.join("\n");
  }

  const inner = lines.slice(1, -1);
  if (passesBoundaryCheck(inner)) {
    return inner.join("\n");
  }

  return lines.join("\n");
}

function checkPatchBoundaries(lines: string[]): void {
  if (!passesBoundaryCheck(lines)) {
    const firstLine = lines[0]?.trim();
    const lastLine = lines[lines.length - 1]?.trim();

    if (firstLine !== BEGIN_PATCH_MARKER) {
      throw new Error("The first line of the patch must be '*** Begin Patch'");
    }

    if (lastLine !== END_PATCH_MARKER) {
      throw new Error("The last line of the patch must be '*** End Patch'");
    }
  }
}

function passesBoundaryCheck(lines: string[]): boolean {
  if (lines.length === 0) {
    return false;
  }

  const firstLine = lines[0]?.trim();
  const lastLine = lines[lines.length - 1]?.trim();
  return firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER;
}

function assertPatchPath(patchPath: string, operation: string): void {
  if (!patchPath.trim()) {
    throw new Error(`${operation} path cannot be empty`);
  }
}

function resolvePatchPath(cwd: string, patchPath: string): string {
  return path.isAbsolute(patchPath) ? patchPath : path.resolve(cwd, patchPath);
}

async function deriveNewContentsFromChunks(
  absolutePath: string,
  filePathForErrors: string,
  chunks: UpdateChunk[],
): Promise<string> {
  let originalContents = "";
  try {
    originalContents = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read file to update ${filePathForErrors}: ${message}`,
    );
  }

  const originalLines = originalContents.split("\n");
  if (originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(
    originalLines,
    filePathForErrors,
    chunks,
  );
  const newLines = applyReplacements([...originalLines], replacements);

  if (newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }

  return newLines.join("\n");
}

type Replacement = [
  startIndex: number,
  oldLength: number,
  newSegment: string[],
];

function computeReplacements(
  originalLines: string[],
  filePathForErrors: string,
  chunks: UpdateChunk[],
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const contextIndex = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (contextIndex === null) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${filePathForErrors}`,
        );
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIndex, 0, [...chunk.newLines]]);
      continue;
    }

    let pattern = [...chunk.oldLines];
    let newSlice = [...chunk.newLines];
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile,
    );

    if (found === null && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.isEndOfFile,
      );
    }

    if (found === null) {
      throw new Error(
        `Failed to find expected lines in ${filePathForErrors}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left[0] - right[0]);
  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Replacement[],
): string[] {
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const [startIndex, oldLength, newSegment] = replacements[i] as Replacement;

    for (let j = 0; j < oldLength; j += 1) {
      if (startIndex < lines.length) {
        lines.splice(startIndex, 1);
      }
    }

    lines.splice(startIndex, 0, ...newSegment);
  }

  return lines;
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) {
    return start;
  }

  if (pattern.length > lines.length) {
    return null;
  }

  const maxStart = lines.length - pattern.length;
  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : start;

  const tryMatch = (
    matches: (line: string, pat: string) => boolean,
  ): number | null => {
    for (let index = searchStart; index <= maxStart; index += 1) {
      let ok = true;
      for (
        let patternIndex = 0;
        patternIndex < pattern.length;
        patternIndex += 1
      ) {
        const line = lines[index + patternIndex] ?? "";
        const pat = pattern[patternIndex] ?? "";
        if (!matches(line, pat)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return index;
      }
    }
    return null;
  };

  return (
    tryMatch((line, pat) => line === pat) ??
    tryMatch((line, pat) => line.trimEnd() === pat.trimEnd()) ??
    tryMatch((line, pat) => line.trim() === pat.trim()) ??
    tryMatch((line, pat) => normalizeForSeek(line) === normalizeForSeek(pat))
  );
}

function normalizeForSeek(value: string): string {
  return value
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(
      /[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g,
      " ",
    );
}
