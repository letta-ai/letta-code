import { getCurrentAgentId } from "../../agent/context";
import { isMemoryDirCommand } from "../../permissions/readOnlyShell";
import { shell } from "./Shell.js";
import { buildShellLaunchers } from "./shellLaunchers.js";
import { ShellExecutionError } from "./shellRunner.js";
import { validateRequiredParams } from "./validation.js";

interface ShellCommandArgs {
  command: string;
  workdir?: string;
  login?: boolean;
  timeout_ms?: number;
  sandbox_permissions?: "use_default" | "require_escalated";
  justification?: string;
  prefix_rule?: string[];
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

interface ShellCommandResult {
  output: string;
  stdout: string[];
  stderr: string[];
}

/**
 * Codex-style shell_command tool.
 * Runs a shell script string in the user's default shell.
 */
export async function shell_command(
  args: ShellCommandArgs,
): Promise<ShellCommandResult> {
  validateRequiredParams(args, ["command"], "shell_command");

  const {
    command,
    workdir,
    login = true,
    timeout_ms,
    justification,
    signal,
    onOutput,
  } = args;
  const envOverrides = getMemoryGitIdentityEnvOverrides(command, workdir);
  const launchers = buildShellLaunchers(command, { login });
  if (launchers.length === 0) {
    throw new Error("Command must be a non-empty string");
  }

  const tried: string[] = [];
  let lastError: Error | null = null;

  for (const launcher of launchers) {
    try {
      return await shell({
        command: launcher,
        workdir,
        env_overrides: envOverrides,
        timeout_ms,
        justification,
        signal,
        onOutput,
      });
    } catch (error) {
      if (error instanceof ShellExecutionError && error.code === "ENOENT") {
        tried.push(launcher[0] || "");
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  const suffix = tried.filter(Boolean).join(", ");
  const reason = lastError?.message || "Shell unavailable";
  throw new Error(suffix ? `${reason} (tried: ${suffix})` : reason);
}

function getMemoryGitIdentityEnvOverrides(
  command: string,
  workdir?: string,
): NodeJS.ProcessEnv | undefined {
  const agentId = getCurrentAgentIdOrEnv();
  if (!agentId) {
    return undefined;
  }

  if (!containsGitCommitInvocation(command)) {
    return undefined;
  }

  const scopedToMemoryDir =
    isMemoryDirCommand(command, agentId) ||
    (workdir
      ? isMemoryDirCommand(`cd ${shellQuote(workdir)} && ${command}`, agentId)
      : false);

  if (!scopedToMemoryDir) {
    return undefined;
  }

  const agentName = (process.env.AGENT_NAME || "").trim() || agentId;
  const agentEmail = `${agentId}@letta.com`;

  return {
    GIT_AUTHOR_NAME: agentName,
    GIT_AUTHOR_EMAIL: agentEmail,
    GIT_COMMITTER_NAME: agentName,
    GIT_COMMITTER_EMAIL: agentEmail,
  };
}

function getCurrentAgentIdOrEnv(): string {
  const envAgentId = (
    process.env.AGENT_ID ||
    process.env.LETTA_AGENT_ID ||
    ""
  ).trim();
  if (envAgentId) {
    return envAgentId;
  }

  try {
    const agentId = getCurrentAgentId().trim();
    if (agentId) {
      return agentId;
    }
  } catch {
    // Fall through to empty string.
  }

  return "";
}

function containsGitCommitInvocation(command: string): boolean {
  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    if (tokens.length === 0) {
      continue;
    }

    let index = 0;
    while (
      index < tokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index] ?? "")
    ) {
      index += 1;
    }

    if (tokens[index] !== "git") {
      continue;
    }

    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (!token) {
        index += 1;
        continue;
      }

      if (token === "-c" || token === "-C") {
        index += 2;
        continue;
      }

      if (token.startsWith("-")) {
        index += 1;
        continue;
      }

      if (token === "commit") {
        return true;
      }
      break;
    }
  }

  return false;
}

function tokenizeSegment(segment: string): string[] {
  const matches = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) {
    return [];
  }
  return matches.map(stripWrappingQuotes);
}

function stripWrappingQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
