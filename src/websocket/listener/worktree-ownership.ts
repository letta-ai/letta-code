import path from "node:path";
import {
  extractDashCArgument,
  splitShellSegmentsAllowCommandSubstitution,
  tokenizeShellWords,
} from "../../permissions/shellAnalysis";
import { getRuntimeContext } from "../../runtime-context";
import { getActiveRuntime, getConversationRuntime } from "./runtime";
import type { ConversationRuntime } from "./types";

const EXPECTED_WORKTREE_TTL_MS = 10_000;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const WORKTREE_ADD_OPTIONS_WITH_VALUE = new Set([
  "-b",
  "-B",
  "--branch",
  "--reason",
]);

const ENV_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-S",
  "--split-string",
  "--argv0",
]);

function isEnvExecutable(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  return normalized === "env" || normalized.endsWith("/env");
}

function isGitExecutable(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  return path.basename(normalized) === "git";
}

function isShellExecutable(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(normalized);

  return (
    basename === "bash" ||
    basename === "sh" ||
    basename === "zsh" ||
    basename === "ash" ||
    basename === "cmd.exe" ||
    basename.includes("powershell") ||
    basename.includes("pwsh")
  );
}

function extractShellCommandArgument(
  launcher: string[],
  startIndex: number,
): string | null {
  const argIndex = launcher.findIndex((token, index) => {
    if (index < startIndex) {
      return false;
    }

    const normalized = token.toLowerCase();
    return (
      normalized === "-command" ||
      normalized === "/c" ||
      normalized === "-c" ||
      normalized === "-lc" ||
      /^-[a-z]*c$/i.test(token)
    );
  });

  if (argIndex >= 0) {
    return launcher[argIndex + 1] ?? null;
  }

  return extractDashCArgument(launcher.slice(startIndex)) ?? null;
}

function resolveShellCommandFromLauncher(launcher: string[]): string | null {
  const first = launcher[0];
  if (!first) return null;

  if (isEnvExecutable(first)) {
    for (let i = 1; i < launcher.length; i += 1) {
      const token = launcher[i];
      if (!token) continue;
      if (token.startsWith("-")) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue;
      if (!isShellExecutable(token)) {
        return null;
      }
      return extractShellCommandArgument(launcher, i + 1);
    }
    return null;
  }

  if (!isShellExecutable(first)) {
    return null;
  }

  return extractShellCommandArgument(launcher, 1);
}

function resolveGitWorktreePathFromTokens(
  tokens: string[],
  cwd: string,
): string | null {
  const gitCommandStart = findGitCommandStartIndex(tokens);
  if (gitCommandStart === null) {
    return null;
  }

  let gitWorkingDirectory = cwd;
  let index = gitCommandStart + 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;

    if (token === "worktree" && tokens[index + 1] === "add") {
      index += 2;
      break;
    }

    if (token === "-C") {
      const candidateCwd = tokens[index + 1];
      if (!candidateCwd) {
        return null;
      }
      gitWorkingDirectory = path.resolve(cwd, candidateCwd);
      index += 2;
      continue;
    }

    if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }

    if (token.startsWith("-")) {
      index += 1;
      continue;
    }

    return null;
  }

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return null;

    if (token === "--") {
      const explicitPath = tokens[index + 1];
      return explicitPath
        ? path.resolve(gitWorkingDirectory, explicitPath)
        : null;
    }

    if (WORKTREE_ADD_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }

    if (token.startsWith("-")) {
      index += 1;
      continue;
    }

    return path.resolve(gitWorkingDirectory, token);
  }

  return null;
}

function findGitCommandStartIndex(tokens: string[]): number | null {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || !ENV_ASSIGNMENT_PATTERN.test(token)) {
      break;
    }
    index += 1;
  }

  if (index >= tokens.length) {
    return null;
  }

  const executable = tokens[index];
  if (!executable) {
    return null;
  }

  if (isEnvExecutable(executable)) {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (!token) {
        index += 1;
        continue;
      }

      if (token === "--") {
        index += 1;
        break;
      }

      if (token.startsWith("--") && token.includes("=")) {
        const [flag] = token.split("=", 1);
        if (flag && ENV_OPTIONS_WITH_VALUE.has(flag)) {
          index += 1;
          continue;
        }
      }

      if (ENV_OPTIONS_WITH_VALUE.has(token)) {
        index += 2;
        continue;
      }

      if (token.startsWith("-") || ENV_ASSIGNMENT_PATTERN.test(token)) {
        index += 1;
        continue;
      }

      break;
    }
  }

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || !ENV_ASSIGNMENT_PATTERN.test(token)) {
      break;
    }
    index += 1;
  }

  if (index >= tokens.length) {
    return null;
  }

  return isGitExecutable(tokens[index] ?? "") ? index : null;
}

export function resolveGitWorktreeAddTargetPath(
  command: string,
  cwd: string,
): string | null {
  const segments = splitShellSegmentsAllowCommandSubstitution(command) ?? [
    command,
  ];

  for (const segment of segments) {
    const resolved = resolveGitWorktreePathFromTokens(
      tokenizeShellWords(segment),
      cwd,
    );
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export function resolveGitWorktreeAddTargetPathFromLauncher(
  launcher: string[],
  cwd: string,
): string | null {
  const shellCommand = resolveShellCommandFromLauncher(launcher);
  if (shellCommand) {
    return resolveGitWorktreeAddTargetPath(shellCommand, cwd);
  }

  return resolveGitWorktreePathFromTokens(launcher, cwd);
}

export function noteExpectedWorktreeForLauncher(
  launcher: string[],
  cwd: string,
): void {
  const expectedWorktreePath = resolveGitWorktreeAddTargetPathFromLauncher(
    launcher,
    cwd,
  );
  if (!expectedWorktreePath) {
    return;
  }

  const runtimeContext = getRuntimeContext();
  const conversationId = runtimeContext?.conversationId;
  if (!conversationId) {
    return;
  }

  const listener = getActiveRuntime();
  if (!listener) {
    return;
  }

  const conversationRuntime = getConversationRuntime(
    listener,
    runtimeContext.agentId ?? null,
    conversationId,
  );
  if (!conversationRuntime) {
    return;
  }

  conversationRuntime.expectedWorktreePath = expectedWorktreePath;
  conversationRuntime.expectedWorktreeExpiresAt =
    Date.now() + EXPECTED_WORKTREE_TTL_MS;
}

export function hasExpectedWorktreePath(
  runtime: ConversationRuntime | null,
  detectedPath: string,
): boolean {
  if (!runtime) {
    return false;
  }

  if (
    runtime.expectedWorktreeExpiresAt !== null &&
    runtime.expectedWorktreeExpiresAt <= Date.now()
  ) {
    clearExpectedWorktreePath(runtime);
    return false;
  }

  return runtime.expectedWorktreePath === detectedPath;
}

export function clearExpectedWorktreePath(
  runtime: ConversationRuntime | null,
): void {
  if (!runtime) {
    return;
  }
  runtime.expectedWorktreePath = null;
  runtime.expectedWorktreeExpiresAt = null;
}

export const __worktreeOwnershipTestUtils = {
  resolveGitWorktreeAddTargetPath,
  resolveGitWorktreeAddTargetPathFromLauncher,
};
