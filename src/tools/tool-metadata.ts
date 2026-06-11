import type { ModPermissionToolMetadata } from "@/mods/types";

const READ_ONLY_TOOL_NAMES = new Set([
  "glob",
  "globgemini",
  "grep",
  "grepfiles",
  "list",
  "listdir",
  "listdirectory",
  "ls",
  "notebookread",
  "read",
  "readfile",
  "readfilegemini",
  "readlsp",
  "readmanyfiles",
  "search",
  "searchfilecontent",
  "searchfiles",
  "skill",
  "taskoutput",
  "viewimage",
]);

const WRITE_TOOL_NAMES = new Set([
  "applypatch",
  "createworktree",
  "edit",
  "memory",
  "memoryapplypatch",
  "multiedit",
  "notebookedit",
  "replace",
  "write",
  "writefile",
  "writefilegemini",
]);

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "execcommand",
  "runshellcommand",
  "runshellcommandgemini",
  "shell",
  "shellcommand",
]);

function normalizedToolName(toolName: string): string {
  return toolName.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function getToolPermissionMetadata(
  toolName: string,
  args: Record<string, unknown> = {},
): ModPermissionToolMetadata {
  const normalized = normalizedToolName(toolName);

  if (normalized === "writestdin") {
    return {
      name: toolName,
      permissionEffect:
        typeof args.chars === "string" && args.chars.length > 0
          ? "write"
          : "read",
    };
  }

  if (READ_ONLY_TOOL_NAMES.has(normalized)) {
    return { name: toolName, permissionEffect: "read" };
  }

  if (WRITE_TOOL_NAMES.has(normalized)) {
    return { name: toolName, permissionEffect: "write" };
  }

  if (SHELL_TOOL_NAMES.has(normalized)) {
    return { name: toolName, permissionEffect: "shell" };
  }

  return { name: toolName, permissionEffect: "unknown" };
}
