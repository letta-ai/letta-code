import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const CHDIR_USAGE = "Usage: /chdir <path> (alias: /cd <path>)";

export function parseChdirCommand(input: string): {
  command: "/chdir" | "/cd";
  pathArg: string | null;
} | null {
  const match = input.trim().match(/^(\/chdir|\/cd)(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const command = match[1]?.toLowerCase() === "/cd" ? "/cd" : "/chdir";
  const rawPath = match[2]?.trim();
  return {
    command,
    pathArg: rawPath ? stripMatchingQuotes(rawPath) : null,
  };
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }

  return value;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export async function resolveChdirTarget(
  pathArg: string,
  currentWorkingDirectory: string,
): Promise<string> {
  const expanded = expandHome(pathArg);
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(currentWorkingDirectory, expanded);
  const normalized = await realpath(resolved);
  const stats = await stat(normalized);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${normalized}`);
  }
  return normalized;
}
