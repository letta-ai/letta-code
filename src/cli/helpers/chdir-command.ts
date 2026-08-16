import { resolveWorkingDirectory } from "@/helpers/working-directory";

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

export async function resolveChdirTarget(
  pathArg: string,
  currentWorkingDirectory: string,
): Promise<string> {
  return resolveWorkingDirectory(pathArg, currentWorkingDirectory);
}
