import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getClient } from "../../agent/client";
import { getCurrentAgentId } from "../../agent/context";
import {
  assertMemoryRepoReadyForWrite,
  commitAndSyncMemoryWrite,
} from "../../agent/memoryGit";
import { validateRequiredParams } from "./validation";

type MemoryCommand =
  | "str_replace"
  | "insert"
  | "delete"
  | "rename"
  | "update_description"
  | "create";

interface MemoryArgs {
  command: MemoryCommand;
  reason: string;
  file_path?: string;
  old_path?: string;
  new_path?: string;
  old_string?: string;
  new_string?: string;
  insert_line?: number;
  insert_text?: string;
  description?: string;
  file_text?: string;
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
    throw new Error("memory: unable to resolve agent id for git author email");
  }

  let agentName = "";
  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    agentName = (agent.name || "").trim();
  } catch {
    // Keep best-effort fallback below
  }

  if (!agentName) {
    agentName = (process.env.AGENT_NAME || "").trim() || agentId;
  }

  return { agentId, agentName };
}

interface MemoryResult {
  message: string;
}

interface ParsedMemoryFile {
  frontmatter: {
    description: string;
    read_only?: string;
  };
  body: string;
}

function normalizeComparableContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

export async function memory(args: MemoryArgs): Promise<MemoryResult> {
  validateRequiredParams(args, ["command", "reason"], "memory");

  const reason = args.reason.trim();
  if (!reason) {
    throw new Error("memory: 'reason' must be a non-empty string");
  }

  const memoryDir = resolveMemoryDir();
  ensureMemoryRepo(memoryDir);

  await assertMemoryRepoReadyForWrite(memoryDir);

  const affectedPaths = await applyMemoryCommand(memoryDir, args);
  if (affectedPaths.length === 0) {
    return {
      message: `Memory ${args.command} completed with no changed paths.`,
    };
  }

  const { agentId, agentName } = await getAgentIdentity();
  const commitResult = await commitAndSyncMemoryWrite({
    memoryDir,
    pathspecs: affectedPaths,
    reason,
    author: {
      agentId,
      authorName: agentName.trim() || agentId,
      authorEmail: `${agentId}@letta.com`,
    },
    replay: async () =>
      applyMemoryCommand(memoryDir, args, { replaying: true }),
  });
  if (!commitResult.committed) {
    return {
      message: `Memory ${args.command} made no effective changes; skipped commit and push.`,
    };
  }

  // Emit memory_updated push event so web UI auto-refreshes
  emitMemoryUpdated(affectedPaths);

  if (commitResult.replayed && commitResult.replayNoop) {
    return {
      message: `Memory ${args.command} matched newer remote memory; skipped an extra commit.`,
    };
  }

  if (commitResult.replayed) {
    return {
      message: `Memory ${args.command} reapplied on top of newer remote memory and pushed (${commitResult.sha?.slice(0, 7) ?? "unknown"}).`,
    };
  }

  return {
    message: `Memory ${args.command} applied and pushed (${commitResult.sha?.slice(0, 7) ?? "unknown"}).`,
  };
}

async function applyMemoryCommand(
  memoryDir: string,
  args: MemoryArgs,
  options?: { replaying?: boolean },
): Promise<string[]> {
  const command = args.command;

  if (command === "create") {
    const pathArg = requireString(args.file_path, "file_path", "create");
    const description = requireString(
      args.description,
      "description",
      "create",
    );
    const label = normalizeMemoryLabel(memoryDir, pathArg, "file_path");
    const filePath = resolveMemoryFilePath(memoryDir, label);
    const relPath = toRepoRelative(memoryDir, filePath);
    const body = args.file_text ?? "";
    const rendered = renderMemoryFile(
      {
        description,
      },
      body,
    );

    if (existsSync(filePath)) {
      if (!options?.replaying) {
        throw new Error(`memory create: block already exists at ${pathArg}`);
      }

      const existingContent = await readFile(filePath, "utf8");
      if (
        normalizeComparableContent(existingContent) ===
        normalizeComparableContent(rendered)
      ) {
        return [relPath];
      }

      throw new Error(`memory create: block already exists at ${pathArg}`);
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, rendered, "utf8");
    return [relPath];
  }

  if (command === "str_replace") {
    const pathArg = requireString(args.file_path, "file_path", "str_replace");
    const oldString = requireString(
      args.old_string,
      "old_string",
      "str_replace",
    );
    const newString = requireString(
      args.new_string,
      "new_string",
      "str_replace",
    );

    const label = normalizeMemoryLabel(memoryDir, pathArg, "file_path");
    const filePath = resolveMemoryFilePath(memoryDir, label);
    const relPath = toRepoRelative(memoryDir, filePath);
    const file = await loadEditableMemoryFile(filePath, pathArg);

    const idx = file.body.indexOf(oldString);
    if (idx === -1) {
      throw new Error(
        "memory str_replace: old_string was not found in the target memory block",
      );
    }

    const nextBody = `${file.body.slice(0, idx)}${newString}${file.body.slice(idx + oldString.length)}`;
    const rendered = renderMemoryFile(file.frontmatter, nextBody);
    await writeFile(filePath, rendered, "utf8");
    return [relPath];
  }

  if (command === "insert") {
    const pathArg = requireString(args.file_path, "file_path", "insert");
    const insertText = requireString(args.insert_text, "insert_text", "insert");

    if (
      typeof args.insert_line !== "number" ||
      Number.isNaN(args.insert_line)
    ) {
      throw new Error("memory insert: 'insert_line' must be a number");
    }

    const label = normalizeMemoryLabel(memoryDir, pathArg, "file_path");
    const filePath = resolveMemoryFilePath(memoryDir, label);
    const relPath = toRepoRelative(memoryDir, filePath);
    const file = await loadEditableMemoryFile(filePath, pathArg);

    const lineNumber = Math.max(1, Math.floor(args.insert_line));
    const existingLines = file.body.length > 0 ? file.body.split("\n") : [];
    const insertion = insertText.split("\n");
    const insertionIndex = Math.min(
      Math.max(lineNumber - 1, 0),
      existingLines.length,
    );

    existingLines.splice(insertionIndex, 0, ...insertion);
    const nextBody = existingLines.join("\n");

    const rendered = renderMemoryFile(file.frontmatter, nextBody);
    await writeFile(filePath, rendered, "utf8");
    return [relPath];
  }

  if (command === "delete") {
    if (options?.replaying) {
      throw new Error(
        "memory delete could not be replayed safely after remote changes",
      );
    }

    const pathArg = requireString(args.file_path, "file_path", "delete");
    const label = normalizeMemoryLabel(memoryDir, pathArg, "file_path");
    const targetPath = resolveMemoryPath(memoryDir, label);

    if (existsSync(targetPath) && (await stat(targetPath)).isDirectory()) {
      const relPath = toRepoRelative(memoryDir, targetPath);
      await rm(targetPath, { recursive: true, force: false });
      return [relPath];
    }

    const filePath = resolveMemoryFilePath(memoryDir, label);
    const relPath = toRepoRelative(memoryDir, filePath);

    await loadEditableMemoryFile(filePath, pathArg);
    await unlink(filePath);
    return [relPath];
  }

  if (command === "rename") {
    const oldPathArg = requireString(args.old_path, "old_path", "rename");
    const newPathArg = requireString(args.new_path, "new_path", "rename");

    const oldLabel = normalizeMemoryLabel(memoryDir, oldPathArg, "old_path");
    const newLabel = normalizeMemoryLabel(memoryDir, newPathArg, "new_path");

    const oldFilePath = resolveMemoryFilePath(memoryDir, oldLabel);
    const newFilePath = resolveMemoryFilePath(memoryDir, newLabel);

    const oldRelPath = toRepoRelative(memoryDir, oldFilePath);
    const newRelPath = toRepoRelative(memoryDir, newFilePath);

    if (existsSync(newFilePath)) {
      throw new Error(
        `memory rename: destination already exists at ${newPathArg}`,
      );
    }

    await loadEditableMemoryFile(oldFilePath, oldPathArg);
    await mkdir(dirname(newFilePath), { recursive: true });
    await rename(oldFilePath, newFilePath);
    return [oldRelPath, newRelPath];
  }

  if (command === "update_description") {
    const pathArg = requireString(
      args.file_path,
      "file_path",
      "update_description",
    );
    const newDescription = requireString(
      args.description,
      "description",
      "update_description",
    );

    const label = normalizeMemoryLabel(memoryDir, pathArg, "file_path");
    const filePath = resolveMemoryFilePath(memoryDir, label);
    const relPath = toRepoRelative(memoryDir, filePath);
    const file = await loadEditableMemoryFile(filePath, pathArg);

    const rendered = renderMemoryFile(
      {
        ...file.frontmatter,
        description: newDescription,
      },
      file.body,
    );
    await writeFile(filePath, rendered, "utf8");
    return [relPath];
  }

  throw new Error(`Unsupported memory command: ${command}`);
}

function resolveMemoryDir(): string {
  const direct = process.env.MEMORY_DIR || process.env.LETTA_MEMORY_DIR;
  if (direct && direct.trim().length > 0) {
    return resolve(direct);
  }

  const contextAgentId = (() => {
    try {
      return getCurrentAgentId().trim();
    } catch {
      return "";
    }
  })();

  const agentId =
    contextAgentId ||
    (process.env.AGENT_ID || process.env.LETTA_AGENT_ID || "").trim();
  if (agentId && agentId.trim().length > 0) {
    return resolve(homedir(), ".letta", "agents", agentId, "memory");
  }

  throw new Error(
    "memory: unable to resolve memory directory. Ensure MEMORY_DIR (or AGENT_ID) is available.",
  );
}

function ensureMemoryRepo(memoryDir: string): void {
  if (!existsSync(memoryDir)) {
    throw new Error(`memory: memory directory does not exist: ${memoryDir}`);
  }
  if (!existsSync(resolve(memoryDir, ".git"))) {
    throw new Error(
      `memory: ${memoryDir} is not a git repository. This tool requires a git-backed memory filesystem.`,
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
    throw new Error(`memory: '${fieldName}' must be a non-empty string`);
  }

  if (raw.startsWith("~/") || raw.startsWith("$HOME/")) {
    throw new Error(
      `memory: '${fieldName}' must be a memory-relative file path, not a home-relative filesystem path`,
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
    throw new Error(`memory: '${fieldName}' must be a non-empty string`);
  }

  const normalized = raw.replace(/\\/g, "/");

  if (normalized.startsWith("/")) {
    throw new Error(
      `memory: '${fieldName}' must be a relative path like system/contacts.md`,
    );
  }

  let label = normalized;
  // Accept optional leading `memory/` directory segment.
  label = label.replace(/^memory\//, "");

  // Normalize away a trailing .md extension for all input styles.
  label = label.replace(/\.md$/, "");

  if (!label) {
    throw new Error(`memory: '${fieldName}' resolves to an empty memory label`);
  }

  const segments = label.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`memory: '${fieldName}' resolves to an empty memory label`);
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `memory: '${fieldName}' contains invalid path traversal segment`,
      );
    }
    if (segment.includes("\0")) {
      throw new Error(`memory: '${fieldName}' contains invalid null bytes`);
    }
  }

  return segments.join("/");
}

function memoryPrefixError(memoryDir: string): string {
  return `The memory tool can only be used to modify files in {${memoryDir}} or provided as a relative path`;
}

function resolveMemoryFilePath(memoryDir: string, label: string): string {
  const absolute = resolveMemoryPath(memoryDir, `${label}.md`);
  return absolute;
}

function resolveMemoryPath(memoryDir: string, path: string): string {
  const absolute = resolve(memoryDir, path);
  const rel = relative(memoryDir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("memory: resolved path escapes memory directory");
  }
  return absolute;
}

function toRepoRelative(memoryDir: string, absolutePath: string): string {
  const rel = relative(memoryDir, absolutePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("memory: path is outside memory repository");
  }
  return rel.replace(/\\/g, "/");
}

async function loadEditableMemoryFile(
  filePath: string,
  sourcePath: string,
): Promise<ParsedMemoryFile> {
  const content = await readFile(filePath, "utf8").catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`memory: failed to read ${sourcePath}: ${message}`);
  });

  const parsed = parseMemoryFile(content);
  if (parsed.frontmatter.read_only === "true") {
    throw new Error(
      `memory: ${sourcePath} is read_only and cannot be modified`,
    );
  }
  return parsed;
}

function parseMemoryFile(content: string): ParsedMemoryFile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("memory: target file is missing required frontmatter");
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
    throw new Error("memory: target file frontmatter is missing 'description'");
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
    throw new Error("memory: 'description' must not be empty");
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
function requireString(
  value: string | undefined,
  field: string,
  command: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`memory ${command}: '${field}' must be a non-empty string`);
  }
  return value;
}

/**
 * Emit a `memory_updated` push event over the WebSocket so the web UI
 * can auto-refresh its memory index without polling.
 */
function emitMemoryUpdated(affectedPaths: string[]): void {
  try {
    // Lazy-import to avoid circular deps — this file is loaded before WS infra
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveRuntime } =
      require("../../websocket/listener/runtime") as {
        getActiveRuntime: () => {
          socket: { readyState: number; send: (data: string) => void } | null;
        } | null;
      };

    const runtime = getActiveRuntime();
    const socket = runtime?.socket;
    if (!socket || socket.readyState !== 1 /* WebSocket.OPEN */) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "memory_updated",
        affected_paths: affectedPaths,
        timestamp: Date.now(),
      }),
    );
  } catch {
    // Best-effort — never break tool execution for a push event
  }
}
