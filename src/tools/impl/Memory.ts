import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { getClient } from "../../agent/client";
import { getCurrentAgentId } from "../../agent/context";
import { validateRequiredParams } from "./validation";

const execFile = promisify(execFileCb);

type MemoryCommand = "str_replace" | "insert" | "delete" | "rename" | "create";

interface MemoryArgs {
  command: MemoryCommand;
  reason: string;
  path?: string;
  old_path?: string;
  new_path?: string;
  old_string?: string;
  new_string?: string;
  insert_line?: number;
  insert_text?: string;
  description?: string;
  file_text?: string;
  limit?: number;
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
    limit: number;
    read_only?: string;
  };
  body: string;
}

const DEFAULT_LIMIT = 2000;

export async function memory(args: MemoryArgs): Promise<MemoryResult> {
  validateRequiredParams(args, ["command", "reason"], "memory");

  const reason = args.reason.trim();
  if (!reason) {
    throw new Error("memory: 'reason' must be a non-empty string");
  }

  const memoryDir = resolveMemoryDir();
  ensureMemoryRepo(memoryDir);

  let affectedPaths: string[] = [];
  const command = args.command;

  if (command === "create") {
    const pathArg = requireString(args.path, "path", "create");
    const description = requireString(
      args.description,
      "description",
      "create",
    );
    const label = normalizeMemoryLabel(pathArg, "path");
    const filePath = resolveMemoryFilePath(memoryDir, label);
    const relPath = toRepoRelative(memoryDir, filePath);

    if (existsSync(filePath)) {
      throw new Error(`memory create: block already exists at ${pathArg}`);
    }

    const limit = args.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("memory create: 'limit' must be a positive integer");
    }

    const body = args.file_text ?? "";
    const rendered = renderMemoryFile(
      {
        description,
        limit,
      },
      body,
    );

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, rendered, "utf8");
    affectedPaths = [relPath];
  } else if (command === "str_replace") {
    const pathArg = requireString(args.path, "path", "str_replace");
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

    const label = normalizeMemoryLabel(pathArg, "path");
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
    affectedPaths = [relPath];
  } else if (command === "insert") {
    const pathArg = requireString(args.path, "path", "insert");
    const insertText = requireString(args.insert_text, "insert_text", "insert");

    if (
      typeof args.insert_line !== "number" ||
      Number.isNaN(args.insert_line)
    ) {
      throw new Error("memory insert: 'insert_line' must be a number");
    }

    const label = normalizeMemoryLabel(pathArg, "path");
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
    affectedPaths = [relPath];
  } else if (command === "delete") {
    const pathArg = requireString(args.path, "path", "delete");
    const label = normalizeMemoryLabel(pathArg, "path");
    const filePath = resolveMemoryFilePath(memoryDir, label);
    const relPath = toRepoRelative(memoryDir, filePath);

    await loadEditableMemoryFile(filePath, pathArg);
    await unlink(filePath);
    affectedPaths = [relPath];
  } else if (command === "rename") {
    const hasDescriptionUpdate =
      typeof args.path === "string" &&
      args.path.trim().length > 0 &&
      typeof args.description === "string" &&
      args.description.trim().length > 0 &&
      !args.old_path &&
      !args.new_path;

    if (hasDescriptionUpdate) {
      const pathArg = requireString(args.path, "path", "rename");
      const newDescription = requireString(
        args.description,
        "description",
        "rename description update",
      );

      const label = normalizeMemoryLabel(pathArg, "path");
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
      affectedPaths = [relPath];
    } else {
      const oldPathArg = requireString(args.old_path, "old_path", "rename");
      const newPathArg = requireString(args.new_path, "new_path", "rename");

      const oldLabel = normalizeMemoryLabel(oldPathArg, "old_path");
      const newLabel = normalizeMemoryLabel(newPathArg, "new_path");

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
      affectedPaths = [oldRelPath, newRelPath];
    }
  } else {
    throw new Error(`Unsupported memory command: ${command}`);
  }

  affectedPaths = Array.from(new Set(affectedPaths)).filter(
    (p) => p.length > 0,
  );
  if (affectedPaths.length === 0) {
    return { message: `Memory ${command} completed with no changed paths.` };
  }

  const commitResult = await commitAndPush(memoryDir, affectedPaths, reason);
  if (!commitResult.committed) {
    return {
      message: `Memory ${command} made no effective changes; skipped commit and push.`,
    };
  }

  return {
    message: `Memory ${command} applied and pushed (${commitResult.sha?.slice(0, 7) ?? "unknown"}).`,
  };
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

function normalizeMemoryLabel(inputPath: string, fieldName: string): string {
  const raw = inputPath.trim();
  if (!raw) {
    throw new Error(`memory: '${fieldName}' must be a non-empty string`);
  }

  const normalized = raw.replace(/\\/g, "/");

  if (/^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(
      `memory: '${fieldName}' must be a memory-relative file path, not an absolute host path`,
    );
  }

  if (normalized.startsWith("~/") || normalized.startsWith("$HOME/")) {
    throw new Error(
      `memory: '${fieldName}' must be a memory-relative file path, not a home-relative filesystem path`,
    );
  }

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

function resolveMemoryFilePath(memoryDir: string, label: string): string {
  const absolute = resolve(memoryDir, `${label}.md`);
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
  let limit: number | undefined;
  let readOnly: string | undefined;

  for (const line of frontmatterText.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (key === "description") {
      description = value;
    } else if (key === "limit") {
      const parsedLimit = Number.parseInt(value, 10);
      if (!Number.isNaN(parsedLimit)) {
        limit = parsedLimit;
      }
    } else if (key === "read_only") {
      readOnly = value;
    }
  }

  if (!description || !description.trim()) {
    throw new Error("memory: target file frontmatter is missing 'description'");
  }
  if (!limit || !Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      "memory: target file frontmatter is missing a valid positive 'limit'",
    );
  }

  return {
    frontmatter: {
      description,
      limit,
      ...(readOnly !== undefined ? { read_only: readOnly } : {}),
    },
    body,
  };
}

function renderMemoryFile(
  frontmatter: { description: string; limit: number; read_only?: string },
  body: string,
): string {
  const description = frontmatter.description.trim();
  if (!description) {
    throw new Error("memory: 'description' must not be empty");
  }
  if (!Number.isInteger(frontmatter.limit) || frontmatter.limit <= 0) {
    throw new Error("memory: 'limit' must be a positive integer");
  }

  const lines = [
    "---",
    `description: ${sanitizeFrontmatterValue(description)}`,
    `limit: ${frontmatter.limit}`,
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

async function runGit(
  memoryDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFile("git", args, {
      cwd: memoryDir,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PAGER: "cat",
        GIT_PAGER: "cat",
      },
    });

    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: string }).stderr ?? "")
        : "";
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error
        ? String((error as { stdout?: string }).stdout ?? "")
        : "";
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(
      `git ${args.join(" ")} failed: ${stderr || stdout || message}`.trim(),
    );
  }
}

async function commitAndPush(
  memoryDir: string,
  pathspecs: string[],
  reason: string,
): Promise<{ committed: boolean; sha?: string }> {
  await runGit(memoryDir, ["add", "-A", "--", ...pathspecs]);

  const status = await runGit(memoryDir, [
    "status",
    "--porcelain",
    "--",
    ...pathspecs,
  ]);
  if (!status.stdout.trim()) {
    return { committed: false };
  }

  const { agentId, agentName } = await getAgentIdentity();
  const authorName = agentName.trim() || agentId;
  const authorEmail = `${agentId}@letta.com`;

  await runGit(memoryDir, [
    "-c",
    `user.name=${authorName}`,
    "-c",
    `user.email=${authorEmail}`,
    "commit",
    "-m",
    reason,
  ]);

  const head = await runGit(memoryDir, ["rev-parse", "HEAD"]);
  const sha = head.stdout.trim();

  try {
    await runGit(memoryDir, ["push"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Memory changes were committed (${sha.slice(0, 7)}) but push failed: ${message}`,
    );
  }

  return {
    committed: true,
    sha,
  };
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
