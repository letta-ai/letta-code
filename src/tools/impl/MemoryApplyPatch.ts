import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getClient } from "../../agent/client";
import { getCurrentAgentId } from "../../agent/context";
import { resolveScopedMemoryDir } from "../../agent/memoryFilesystem";
import {
  assertMemoryRepoReadyForWrite,
  commitAndSyncMemoryWrite,
} from "../../agent/memoryGit";
import { validateRequiredParams } from "./validation";

type ParsedPatchOp =
  | {
      kind: "add";
      targetLabel: string;
      targetRelPath: string;
      contentLines: string[];
    }
  | {
      kind: "update";
      sourceLabel: string;
      sourceRelPath: string;
      targetLabel: string;
      targetRelPath: string;
      hunks: Hunk[];
    }
  | {
      kind: "delete";
      targetLabel: string;
      targetRelPath: string;
    };

interface Hunk {
  lines: string[];
}

interface ParsedMemoryFile {
  frontmatter: {
    description: string;
    read_only?: string;
  };
  body: string;
}

interface MemoryApplyPatchArgs {
  reason: string;
  input: string;
}

interface MemoryApplyPatchResult {
  message: string;
}

async function getAgentIdentity(): Promise<{
  agentId: string;
  agentName: string;
}> {
  const envAgentId = (
    process.env.AGENT_ID ||
    process.env.LETTA_AGENT_ID ||
    ""
  ).trim();
  const contextAgentId = (() => {
    try {
      return getCurrentAgentId().trim();
    } catch {
      return "";
    }
  })();
  const agentId = contextAgentId || envAgentId;

  if (!agentId) {
    throw new Error(
      "memory_apply_patch: unable to resolve agent id for git author email",
    );
  }

  let agentName = "";
  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    agentName = (agent.name || "").trim();
  } catch {
    // best-effort fallback below
  }

  if (!agentName) {
    agentName = (process.env.AGENT_NAME || "").trim() || agentId;
  }

  return { agentId, agentName };
}

export async function memory_apply_patch(
  args: MemoryApplyPatchArgs,
): Promise<MemoryApplyPatchResult> {
  validateRequiredParams(args, ["reason", "input"], "memory_apply_patch");

  const reason = args.reason.trim();
  if (!reason) {
    throw new Error("memory_apply_patch: 'reason' must be a non-empty string");
  }

  const input = args.input;
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("memory_apply_patch: 'input' must be a non-empty string");
  }

  const memoryDir = resolveMemoryDir();
  ensureMemoryRepo(memoryDir);

  const { agentId, agentName } = await getAgentIdentity();
  await assertMemoryRepoReadyForWrite(memoryDir, agentId);

  const pathspecs = await applyMemoryPatch(memoryDir, input);
  if (pathspecs.length === 0) {
    return { message: "memory_apply_patch completed with no changed paths." };
  }

  const commitResult = await commitAndSyncMemoryWrite({
    memoryDir,
    pathspecs,
    reason,
    author: {
      agentId,
      authorName: agentName.trim() || agentId,
      authorEmail: `${agentId}@letta.com`,
    },
    replay: async () => applyMemoryPatch(memoryDir, input),
  });
  if (!commitResult.committed) {
    return {
      message:
        "memory_apply_patch made no effective changes; skipped commit and push.",
    };
  }

  if (commitResult.replayed && commitResult.replayNoop) {
    return {
      message:
        "memory_apply_patch matched newer remote memory; skipped an extra commit.",
    };
  }

  if (commitResult.replayed) {
    return {
      message: `memory_apply_patch reapplied on top of newer remote memory and pushed (${commitResult.sha?.slice(0, 7) ?? "unknown"}).`,
    };
  }

  return {
    message: `memory_apply_patch applied and pushed (${commitResult.sha?.slice(0, 7) ?? "unknown"}).`,
  };
}

async function applyMemoryPatch(
  memoryDir: string,
  input: string,
): Promise<string[]> {
  const ops = parsePatchOperations(memoryDir, input);
  if (ops.length === 0) {
    throw new Error("memory_apply_patch: no file operations found in patch");
  }

  const pendingWrites = new Map<string, string>();
  const pendingDeletes = new Set<string>();
  const affectedPaths = new Set<string>();

  const loadCurrentContent = async (
    relPath: string,
    sourcePathForErrors: string,
  ): Promise<string> => {
    const absPath = resolveMemoryPath(memoryDir, relPath);
    if (pendingDeletes.has(absPath) && !pendingWrites.has(absPath)) {
      throw new Error(
        `memory_apply_patch: file not found for update: ${sourcePathForErrors}`,
      );
    }

    const pending = pendingWrites.get(absPath);
    if (pending !== undefined) {
      return pending;
    }

    const content = await readFile(absPath, "utf8").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `memory_apply_patch: failed to read ${sourcePathForErrors}: ${message}`,
      );
    });

    return content.replace(/\r\n/g, "\n");
  };

  for (const op of ops) {
    if (op.kind === "add") {
      const absPath = resolveMemoryFilePath(memoryDir, op.targetLabel);
      if (pendingWrites.has(absPath)) {
        throw new Error(
          `memory_apply_patch: duplicate add/update target in patch: ${op.targetRelPath}`,
        );
      }
      if (!(await isMissing(absPath))) {
        throw new Error(
          `memory_apply_patch: cannot add existing memory file: ${op.targetRelPath}`,
        );
      }

      const rawContent = op.contentLines.join("\n");
      const rendered = normalizeAddedContent(op.targetLabel, rawContent);

      pendingWrites.set(absPath, rendered);
      pendingDeletes.delete(absPath);
      affectedPaths.add(toRepoRelative(memoryDir, absPath));
      continue;
    }

    if (op.kind === "delete") {
      const absPath = resolveMemoryFilePath(memoryDir, op.targetLabel);
      await loadEditableMemoryFile(absPath, op.targetRelPath);
      pendingWrites.delete(absPath);
      pendingDeletes.add(absPath);
      affectedPaths.add(toRepoRelative(memoryDir, absPath));
      continue;
    }

    const sourceAbsPath = resolveMemoryFilePath(memoryDir, op.sourceLabel);
    const targetAbsPath = resolveMemoryFilePath(memoryDir, op.targetLabel);

    const currentContent = await loadCurrentContent(
      op.sourceRelPath,
      op.sourceRelPath,
    );
    const currentParsed = parseMemoryFile(currentContent);
    if (currentParsed.frontmatter.read_only === "true") {
      throw new Error(
        `memory_apply_patch: ${op.sourceRelPath} is read_only and cannot be modified`,
      );
    }

    let nextContent = currentContent;
    for (const hunk of op.hunks) {
      nextContent = applyHunk(nextContent, hunk.lines, op.sourceRelPath);
    }

    const validated = parseMemoryFile(nextContent);
    if (validated.frontmatter.read_only === "true") {
      throw new Error(
        `memory_apply_patch: ${op.targetRelPath} cannot be written with read_only=true`,
      );
    }

    pendingWrites.set(targetAbsPath, nextContent);
    pendingDeletes.delete(targetAbsPath);
    affectedPaths.add(toRepoRelative(memoryDir, targetAbsPath));

    if (sourceAbsPath !== targetAbsPath) {
      if (!pendingDeletes.has(sourceAbsPath)) {
        pendingWrites.delete(sourceAbsPath);
        pendingDeletes.add(sourceAbsPath);
      }
      affectedPaths.add(toRepoRelative(memoryDir, sourceAbsPath));
    }
  }

  for (const [absPath, content] of pendingWrites.entries()) {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
  }

  for (const absPath of pendingDeletes) {
    if (pendingWrites.has(absPath)) continue;
    if (await isMissing(absPath)) continue;
    const stats = await stat(absPath);
    if (stats.isDirectory()) {
      await rm(absPath, { recursive: true, force: false });
    } else {
      await unlink(absPath);
    }
  }

  const pathspecs = Array.from(affectedPaths).filter((p) => p.length > 0);
  return pathspecs;
}

function parsePatchOperations(
  memoryDir: string,
  input: string,
): ParsedPatchOp[] {
  const lines = input.split(/\r?\n/);
  const beginIndex = lines.findIndex(
    (line) => line.trim() === "*** Begin Patch",
  );
  if (beginIndex !== 0) {
    throw new Error(
      'memory_apply_patch: patch must start with "*** Begin Patch"',
    );
  }

  const endIndex = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (endIndex === -1) {
    throw new Error('memory_apply_patch: patch must end with "*** End Patch"');
  }

  for (let tail = endIndex + 1; tail < lines.length; tail += 1) {
    if ((lines[tail] ?? "").trim().length > 0) {
      throw new Error(
        "memory_apply_patch: unexpected content after *** End Patch",
      );
    }
  }

  const ops: ParsedPatchOp[] = [];
  let i = 1;

  while (i < endIndex) {
    const line = lines[i]?.trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (line.startsWith("*** Add File:")) {
      const rawPath = line.replace("*** Add File:", "").trim();
      const label = normalizeMemoryLabel(memoryDir, rawPath, "Add File path");
      const targetRelPath = `${label}.md`;

      i += 1;
      const contentLines: string[] = [];
      while (i < endIndex) {
        const raw = lines[i];
        if (raw === undefined || raw.startsWith("*** ")) {
          break;
        }
        if (!raw.startsWith("+")) {
          throw new Error(
            `memory_apply_patch: invalid Add File line at ${i + 1}: expected '+' prefix`,
          );
        }
        contentLines.push(raw.slice(1));
        i += 1;
      }

      if (contentLines.length === 0) {
        throw new Error(
          `memory_apply_patch: Add File for ${rawPath} must include at least one + line`,
        );
      }

      ops.push({
        kind: "add",
        targetLabel: label,
        targetRelPath,
        contentLines,
      });
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const rawSourcePath = line.replace("*** Update File:", "").trim();
      const sourceLabel = normalizeMemoryLabel(
        memoryDir,
        rawSourcePath,
        "Update File path",
      );
      let targetLabel = sourceLabel;

      i += 1;
      if (i < endIndex) {
        const moveLine = lines[i];
        if (moveLine?.startsWith("*** Move to:")) {
          const rawTargetPath = moveLine.replace("*** Move to:", "").trim();
          targetLabel = normalizeMemoryLabel(
            memoryDir,
            rawTargetPath,
            "Move to path",
          );
          i += 1;
        }
      }

      const hunks: Hunk[] = [];
      while (i < endIndex) {
        const hLine = lines[i];
        if (hLine === undefined || hLine.startsWith("*** ")) {
          break;
        }

        if (!hLine.startsWith("@@")) {
          throw new Error(
            `memory_apply_patch: invalid Update File body at ${i + 1}: expected '@@' hunk header`,
          );
        }

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
              `memory_apply_patch: invalid hunk line at ${i + 1}: expected one of ' ', '+', '-'`,
            );
          }
          i += 1;
        }
        hunks.push({ lines: hunkLines });
      }

      if (hunks.length === 0) {
        throw new Error(
          `memory_apply_patch: Update File for ${rawSourcePath} has no hunks`,
        );
      }

      ops.push({
        kind: "update",
        sourceLabel,
        sourceRelPath: `${sourceLabel}.md`,
        targetLabel,
        targetRelPath: `${targetLabel}.md`,
        hunks,
      });
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const rawPath = line.replace("*** Delete File:", "").trim();
      const label = normalizeMemoryLabel(
        memoryDir,
        rawPath,
        "Delete File path",
      );
      ops.push({
        kind: "delete",
        targetLabel: label,
        targetRelPath: `${label}.md`,
      });
      i += 1;
      continue;
    }

    throw new Error(
      `memory_apply_patch: unknown patch directive at line ${i + 1}: ${line}`,
    );
  }

  return ops;
}

function normalizeAddedContent(label: string, rawContent: string): string {
  try {
    const parsed = parseMemoryFile(rawContent);
    return renderMemoryFile(parsed.frontmatter, parsed.body);
  } catch {
    return renderMemoryFile(
      {
        description: `Memory block ${label}`,
      },
      rawContent,
    );
  }
}

function resolveMemoryDir(): string {
  const scopedMemoryDir = resolveScopedMemoryDir();
  if (scopedMemoryDir) {
    return scopedMemoryDir;
  }

  throw new Error(
    "memory_apply_patch: unable to resolve memory directory. Ensure MEMORY_DIR (or AGENT_ID) is available.",
  );
}

function ensureMemoryRepo(memoryDir: string): void {
  if (!existsSync(memoryDir)) {
    throw new Error(
      `memory_apply_patch: memory directory does not exist: ${memoryDir}`,
    );
  }
  if (!existsSync(resolve(memoryDir, ".git"))) {
    throw new Error(
      `memory_apply_patch: ${memoryDir} is not a git repository. This tool requires a git-backed memory filesystem.`,
    );
  }
}

function normalizeMemoryLabel(
  memoryDir: string,
  inputPath: string,
  fieldName: string,
): string {
  const raw = inputPath.trim();
  if (!raw) {
    throw new Error(
      `memory_apply_patch: '${fieldName}' must be a non-empty string`,
    );
  }

  if (raw.startsWith("~/") || raw.startsWith("$HOME/")) {
    throw new Error(
      `memory_apply_patch: '${fieldName}' must be a memory-relative file path, not a home-relative filesystem path`,
    );
  }

  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(raw);
  if (isAbsolute(raw) || isWindowsAbsolute) {
    const absolutePath = resolve(raw);
    const relToMemory = relative(memoryDir, absolutePath);

    if (
      relToMemory &&
      !relToMemory.startsWith("..") &&
      !isAbsolute(relToMemory)
    ) {
      return normalizeRelativeMemoryLabel(relToMemory, fieldName);
    }

    throw new Error(memoryPrefixError(memoryDir));
  }

  return normalizeRelativeMemoryLabel(raw, fieldName);
}

function normalizeRelativeMemoryLabel(
  inputPath: string,
  fieldName: string,
): string {
  const raw = inputPath.trim();
  if (!raw) {
    throw new Error(
      `memory_apply_patch: '${fieldName}' must be a non-empty string`,
    );
  }

  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new Error(
      `memory_apply_patch: '${fieldName}' must be a relative path like system/contacts.md`,
    );
  }

  let label = normalized;
  label = label.replace(/^memory\//, "");
  label = label.replace(/\.md$/, "");

  if (!label) {
    throw new Error(
      `memory_apply_patch: '${fieldName}' resolves to an empty memory label`,
    );
  }

  const segments = label.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(
      `memory_apply_patch: '${fieldName}' resolves to an empty memory label`,
    );
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `memory_apply_patch: '${fieldName}' contains invalid path traversal segment`,
      );
    }
    if (segment.includes("\0")) {
      throw new Error(
        `memory_apply_patch: '${fieldName}' contains invalid null bytes`,
      );
    }
  }

  return segments.join("/");
}

function memoryPrefixError(memoryDir: string): string {
  return `The memory_apply_patch tool can only be used to modify files in {${memoryDir}} or provided as a relative path`;
}

function resolveMemoryPath(memoryDir: string, path: string): string {
  const absolute = resolve(memoryDir, path);
  const rel = relative(memoryDir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      "memory_apply_patch: resolved path escapes memory directory",
    );
  }
  return absolute;
}

function resolveMemoryFilePath(memoryDir: string, label: string): string {
  return resolveMemoryPath(memoryDir, `${label}.md`);
}

function toRepoRelative(memoryDir: string, absolutePath: string): string {
  const rel = relative(memoryDir, absolutePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("memory_apply_patch: path is outside memory repository");
  }
  return rel.replace(/\\/g, "/");
}

async function loadEditableMemoryFile(
  filePath: string,
  sourcePath: string,
): Promise<ParsedMemoryFile> {
  const content = await readFile(filePath, "utf8").catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `memory_apply_patch: failed to read ${sourcePath}: ${message}`,
    );
  });

  const parsed = parseMemoryFile(content);
  if (parsed.frontmatter.read_only === "true") {
    throw new Error(
      `memory_apply_patch: ${sourcePath} is read_only and cannot be modified`,
    );
  }
  return parsed;
}

function parseMemoryFile(content: string): ParsedMemoryFile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(
      "memory_apply_patch: target file is missing required frontmatter",
    );
  }

  const frontmatterText = match[1] ?? "";
  const body = match[2] ?? "";

  let description: string | undefined;
  let readOnly: string | undefined;

  for (const line of frontmatterText.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (key === "description") {
      description = value;
    } else if (key === "read_only") {
      readOnly = value;
    }
  }

  if (!description || !description.trim()) {
    throw new Error(
      "memory_apply_patch: target file frontmatter is missing 'description'",
    );
  }

  return {
    frontmatter: {
      description,
      ...(readOnly !== undefined ? { read_only: readOnly } : {}),
    },
    body,
  };
}

function renderMemoryFile(
  frontmatter: { description: string; read_only?: string },
  body: string,
): string {
  const description = frontmatter.description.trim();
  if (!description) {
    throw new Error("memory_apply_patch: 'description' must not be empty");
  }

  const lines = [
    "---",
    `description: ${sanitizeFrontmatterValue(description)}`,
  ];

  if (frontmatter.read_only !== undefined) {
    lines.push(`read_only: ${frontmatter.read_only}`);
  }

  lines.push("---");

  const header = lines.join("\n");
  if (!body) {
    return `${header}\n`;
  }
  return `${header}\n${body}`;
}

function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

async function isMissing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
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
      `memory_apply_patch: failed to apply hunk to ${filePath}: hunk has no anchor/context`,
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

  throw new Error(
    `memory_apply_patch: failed to apply hunk to ${filePath}: context not found`,
  );
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
