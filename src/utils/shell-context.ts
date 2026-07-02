import { platform } from "node:os";

export type ShellFamily = "powershell" | "cmd" | "bash" | "unknown";

export interface ShellContext {
  family: ShellFamily;
  displayName: string;
}

function normalizeShellPath(value: string): string {
  return value.trim().toLowerCase();
}

function detectWindowsShell(env: NodeJS.ProcessEnv): ShellContext {
  const shell = env.SHELL?.trim();
  if (shell) {
    const normalized = normalizeShellPath(shell);
    if (
      normalized.includes("bash") ||
      normalized.includes("zsh") ||
      normalized.includes("sh")
    ) {
      return { family: "bash", displayName: shell };
    }
  }

  const powershellPathHint = env.PSModulePath?.trim() ?? "";
  if (
    powershellPathHint ||
    env.PSExecutionPolicyPreference?.trim() ||
    env.PSEdition?.trim() ||
    env.__PSLockdownPolicy?.trim()
  ) {
    return {
      family: "powershell",
      displayName: powershellPathHint.includes("PowerShell\\7")
        ? "PowerShell 7"
        : "PowerShell",
    };
  }

  const comSpec = env.ComSpec?.trim();
  if (comSpec) {
    const normalized = normalizeShellPath(comSpec);
    if (normalized.includes("powershell")) {
      return { family: "powershell", displayName: "PowerShell" };
    }
    if (normalized.includes("cmd.exe")) {
      return { family: "cmd", displayName: "Command Prompt" };
    }
  }

  return { family: "unknown", displayName: "Windows shell" };
}

export function detectShellContext(
  env: NodeJS.ProcessEnv = process.env,
  currentPlatform: NodeJS.Platform = platform(),
): ShellContext {
  if (currentPlatform !== "win32") {
    const shell = env.SHELL?.trim();
    if (shell) {
      return { family: "bash", displayName: shell };
    }
    return { family: "unknown", displayName: "shell" };
  }

  return detectWindowsShell(env);
}
