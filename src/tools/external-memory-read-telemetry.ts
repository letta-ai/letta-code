import { existsSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { resolveScopedMemoryDir } from "@/agent/memory-filesystem";
import { telemetry } from "@/telemetry";

export type ExternalMemoryAccessKind = "list" | "read" | "search";

export interface ExternalMemoryReadTarget {
  accessKind: ExternalMemoryAccessKind;
  limit?: number;
  offset?: number;
  path: string;
  repositoryName?: string;
  repositoryType: "agent_memory" | "attached_repository";
}

interface ToolTarget {
  accessKind: ExternalMemoryAccessKind;
  limit?: number;
  offset?: number;
  path: string;
}

interface TrackBuiltInToolUsageParams {
  agentId?: string;
  args: Record<string, unknown>;
  conversationId?: string | null;
  durationMs: number;
  errorType?: string;
  memoryDir?: string | null;
  responseLength?: number;
  stderr?: string;
  success: boolean;
  toolCallId?: string;
  toolName: string;
  workingDirectory: string;
}

const READ_TOOL_NAMES = new Set([
  "Read",
  "ReadFile",
  "ReadFileGemini",
  "ReadLSP",
  "read_file",
  "read_file_gemini",
  "view_image",
  "ViewImage",
]);
const SEARCH_TOOL_NAMES = new Set([
  "Grep",
  "GrepFiles",
  "SearchFileContent",
  "grep_files",
  "search_file_content",
]);
const GLOB_TOOL_NAMES = new Set(["Glob", "GlobGemini", "glob_gemini"]);
const DIRECTORY_LIST_TOOL_NAMES = new Set([
  "LS",
  "ListDir",
  "ListDirectory",
  "list_dir",
  "list_directory",
]);
const READ_MANY_TOOL_NAMES = new Set(["ReadManyFiles", "read_many_files"]);

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function pathArg(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function extractToolTargets(
  toolName: string,
  args: Record<string, unknown>,
  workingDirectory: string,
): ToolTarget[] {
  if (READ_TOOL_NAMES.has(toolName)) {
    const path = pathArg(args, ["file_path", "absolute_path", "path"]);
    return path
      ? [
          {
            accessKind: "read",
            limit: numberArg(args.limit),
            offset: numberArg(args.offset),
            path,
          },
        ]
      : [];
  }

  if (READ_MANY_TOOL_NAMES.has(toolName)) {
    return Array.isArray(args.include)
      ? args.include.flatMap((value) =>
          typeof value === "string" && value.trim()
            ? [{ accessKind: "read" as const, path: value }]
            : [],
        )
      : [];
  }

  if (SEARCH_TOOL_NAMES.has(toolName)) {
    return [
      {
        accessKind: "search",
        path:
          pathArg(args, ["path", "dir_path", "absolute_path"]) ??
          workingDirectory,
      },
    ];
  }

  if (GLOB_TOOL_NAMES.has(toolName)) {
    const directory =
      pathArg(args, ["path", "dir_path", "absolute_path"]) ?? workingDirectory;
    const pattern = pathArg(args, ["pattern"]);
    return [
      {
        accessKind: "list",
        path:
          pattern && !isAbsolute(pattern)
            ? join(directory, pattern)
            : (pattern ?? directory),
      },
    ];
  }

  if (DIRECTORY_LIST_TOOL_NAMES.has(toolName)) {
    return [
      {
        accessKind: "list",
        path:
          pathArg(args, ["path", "dir_path", "absolute_path"]) ??
          workingDirectory,
      },
    ];
  }

  return [];
}

function replaceMemoryDirPrefix(value: string, memoryDir: string): string {
  return value
    .replace(/^\$MEMORY_DIR(?=$|[\\/])/, memoryDir)
    .replace(/^\$\{MEMORY_DIR\}(?=$|[\\/])/, memoryDir);
}

function resolveTargetPath(
  value: string,
  memoryDir: string,
  workingDirectory: string,
): string {
  const expanded = replaceMemoryDirPrefix(value.trim(), memoryDir);
  return isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(workingDirectory, expanded);
}

function canonicalizePath(targetPath: string): string {
  let existingPath = targetPath;
  const missingParts: string[] = [];
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) return targetPath;
    missingParts.unshift(basename(existingPath));
    existingPath = parent;
  }

  try {
    return resolve(realpathSync(existingPath), ...missingParts);
  } catch {
    return targetPath;
  }
}

function isWithinDirectory(targetPath: string, directory: string): boolean {
  const rel = relative(directory, targetPath);
  return (
    rel === "" ||
    (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== "..")
  );
}

function toPortablePath(value: string): string {
  return value.split(sep).join("/") || ".";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function classifyAgentMemoryPath(
  target: ToolTarget,
  targetPath: string,
  memoryDir: string,
): ExternalMemoryReadTarget | null {
  if (!isWithinDirectory(targetPath, memoryDir)) return null;

  const relativePath = relative(memoryDir, targetPath);
  if (!relativePath) return null;
  const [rootName, ...rest] = relativePath.split(sep);
  if (!rootName || rootName === ".git" || rootName === "skills") return null;

  const isV2 = existsSync(resolve(memoryDir, "MEMORY.md"));
  if (isV2) {
    const targetsExternalDirectory = rest.length > 0 || isDirectory(targetPath);
    if (!targetsExternalDirectory) return null;
  } else if (rootName === "system") {
    return null;
  }

  return {
    accessKind: target.accessKind,
    limit: target.limit,
    offset: target.offset,
    path: toPortablePath(relativePath),
    repositoryType: "agent_memory",
  };
}

function classifyAttachedRepositoryPath(
  target: ToolTarget,
  targetPath: string,
  memoryDir: string,
): ExternalMemoryReadTarget | null {
  const agentDirectory = dirname(memoryDir);
  if (!isWithinDirectory(targetPath, agentDirectory)) return null;

  const pathFromAgentDirectory = relative(agentDirectory, targetPath);
  const [repositoryName, ...repositoryPathParts] =
    pathFromAgentDirectory.split(sep);
  if (!repositoryName || repositoryName === "memory") return null;

  const repositoryDirectory = resolve(agentDirectory, repositoryName);
  if (!existsSync(resolve(repositoryDirectory, ".git"))) return null;

  return {
    accessKind: target.accessKind,
    limit: target.limit,
    offset: target.offset,
    path: toPortablePath(repositoryPathParts.join(sep)),
    repositoryName,
    repositoryType: "attached_repository",
  };
}

export function classifyExternalMemoryReads(params: {
  args: Record<string, unknown>;
  memoryDir: string;
  toolName: string;
  workingDirectory: string;
}): ExternalMemoryReadTarget[] {
  const memoryDir = canonicalizePath(resolve(params.memoryDir));
  const targets = extractToolTargets(
    params.toolName,
    params.args,
    params.workingDirectory,
  );
  const seen = new Set<string>();

  return targets.flatMap((target) => {
    let targetPath = resolveTargetPath(
      target.path,
      memoryDir,
      params.workingDirectory,
    );
    if (target.accessKind === "search" && isDirectory(targetPath)) {
      targetPath = resolve(targetPath, "**", "*");
    }
    targetPath = canonicalizePath(targetPath);
    const classified =
      classifyAgentMemoryPath(target, targetPath, memoryDir) ??
      classifyAttachedRepositoryPath(target, targetPath, memoryDir);
    if (!classified) return [];

    const key = `${classified.repositoryType}:${classified.repositoryName ?? ""}:${classified.path}:${classified.accessKind}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [classified];
  });
}

export function trackBuiltInToolUsage(
  params: TrackBuiltInToolUsageParams,
): void {
  telemetry.trackToolUsage(
    params.toolName,
    params.success,
    params.durationMs,
    params.responseLength,
    params.errorType,
    params.stderr,
  );

  const memoryDir =
    params.memoryDir ??
    resolveScopedMemoryDir({ agentId: params.agentId ?? null });
  if (!memoryDir) return;

  const targets = classifyExternalMemoryReads({
    args: params.args,
    memoryDir,
    toolName: params.toolName,
    workingDirectory: params.workingDirectory,
  });
  if (targets.length === 0) return;

  const eventTargets = targets.slice(0, 20).map((target) => ({
    path: target.path,
    repository_name: target.repositoryName,
    repository_type: target.repositoryType,
  }));
  telemetry.trackExternalMemoryRead(
    {
      access_kind: targets[0]?.accessKind ?? "read",
      conversation_id: params.conversationId ?? undefined,
      duration_ms: params.durationMs,
      limit: targets[0]?.limit,
      offset: targets[0]?.offset,
      response_length: params.responseLength,
      success: params.success,
      target_count: targets.length,
      targets: eventTargets,
      targets_truncated: targets.length > eventTargets.length,
      tool_call_id: params.toolCallId,
      tool_name: params.toolName,
    },
    params.agentId,
  );
}
