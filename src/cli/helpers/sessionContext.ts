// src/cli/helpers/sessionContext.ts
// Generates session context system reminder for the first message of each CLI session

import { execSync } from "node:child_process";
import { platform } from "node:os";
import { LETTA_CLOUD_API_URL } from "../../auth/oauth";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import { settingsManager } from "../../settings-manager";
import { getVersion } from "../../version";

interface AgentInfo {
  id: string;
  name: string | null;
  description?: string | null;
  lastRunAt?: string | null;
}

interface SessionContextOptions {
  agentInfo: AgentInfo;
  serverUrl?: string;
}

/**
 * Get the current local time in a human-readable format
 */
function getLocalTime(): string {
  const now = new Date();
  return now.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * Get device type based on platform
 */
function getDeviceType(): string {
  const p = platform();
  switch (p) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return p;
  }
}

/**
 * Format relative time from a date string
 */
function getRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  }
  if (diffHours > 0) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }
  if (diffMins > 0) {
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/**
 * Safely execute a git command, returning null on failure
 */
function safeGitExec(command: string, cwd: string): string | null {
  try {
    return execSync(command, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

/**
 * Gather git information if in a git repository
 * Returns truncated commits (3) and status (20 lines)
 * Each field is gathered independently with fallbacks
 */
function getGitInfo(): {
  isGitRepo: boolean;
  branch?: string;
  recentCommits?: string;
  status?: string;
} {
  const cwd = process.cwd();

  try {
    // Check if we're in a git repo
    execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });

    // Get current branch (with fallback)
    const branch = safeGitExec("git branch --show-current", cwd) ?? "(unknown)";

    // Get recent commits (3 commits with author, with fallback)
    const recentCommits =
      safeGitExec('git log --format="%h %s (%an)" -3', cwd) ??
      "(failed to get commits)";

    // Get git status (truncate to 20 lines, with fallback)
    const fullStatus =
      safeGitExec("git status --short", cwd) ?? "(failed to get status)";
    const statusLines = fullStatus.split("\n");
    let status = fullStatus;
    if (statusLines.length > 20) {
      status =
        statusLines.slice(0, 20).join("\n") +
        `\n... and ${statusLines.length - 20} more files`;
    }

    return {
      isGitRepo: true,
      branch,
      recentCommits,
      status: status || "(clean working tree)",
    };
  } catch {
    return { isGitRepo: false };
  }
}

/**
 * Build the full session context system reminder
 * Returns empty string on any failure (graceful degradation)
 */
export function buildSessionContext(options: SessionContextOptions): string {
  try {
    const { agentInfo, serverUrl } = options;
    const cwd = process.cwd();

    // Gather info with safe fallbacks
    let version = "unknown";
    try {
      version = getVersion();
    } catch {
      // version stays "unknown"
    }

    let deviceType = "unknown";
    try {
      deviceType = getDeviceType();
    } catch {
      // deviceType stays "unknown"
    }

    let localTime = "unknown";
    try {
      localTime = getLocalTime();
    } catch {
      // localTime stays "unknown"
    }

    const gitInfo = getGitInfo();

    // Get server URL
    let actualServerUrl = LETTA_CLOUD_API_URL;
    try {
      const settings = settingsManager.getSettings();
      actualServerUrl =
        serverUrl ||
        process.env.LETTA_BASE_URL ||
        settings.env?.LETTA_BASE_URL ||
        LETTA_CLOUD_API_URL;
    } catch {
      // actualServerUrl stays default
    }

    // Format last run info
    let lastRunInfo = "No previous messages";
    if (agentInfo.lastRunAt) {
      try {
        const lastRunDate = new Date(agentInfo.lastRunAt);
        const localLastRun = lastRunDate.toLocaleString();
        const relativeTime = getRelativeTime(agentInfo.lastRunAt);
        lastRunInfo = `${localLastRun} (${relativeTime})`;
      } catch {
        lastRunInfo = "(failed to parse last run time)";
      }
    }

    // Build the context
    let context = `${SYSTEM_REMINDER_OPEN}
This is an automated message providing context about the user's environment.
The user has just initiated a new connection via the [Letta Code CLI client](https://docs.letta.com/letta-code/index.md).

## Device Information
- **Local time**: ${localTime}
- **Device type**: ${deviceType}
- **Letta Code version**: ${version}
- **Current working directory**: ${cwd}
`;

    // Add git info if available
    if (gitInfo.isGitRepo) {
      context += `- **Git repository**: Yes (branch: ${gitInfo.branch})

### Recent Commits
\`\`\`
${gitInfo.recentCommits}
\`\`\`

### Git Status
\`\`\`
${gitInfo.status}
\`\`\`
`;
    } else {
      context += `- **Git repository**: No
`;
    }

    // Add Windows-specific shell guidance
    if (platform() === "win32") {
      context += `
## Windows Shell Notes
- The Bash tool uses PowerShell or cmd.exe on Windows
- HEREDOC syntax (e.g., \`$(cat <<'EOF'...EOF)\`) does NOT work on Windows
- For multiline strings (git commits, PR bodies), use simple quoted strings instead
`;
    }

    // Add agent info
    context += `
## Agent Information (i.e. information about you)
- **Agent ID**: ${agentInfo.id}
- **Agent name**: ${agentInfo.name || "(unnamed)"} (the user can change this with /rename)
- **Agent description**: ${agentInfo.description || "(no description)"} (the user can change this with /description)
- **Last message**: ${lastRunInfo}
- **Server location**: ${actualServerUrl}
${SYSTEM_REMINDER_CLOSE}`;

    return context;
  } catch {
    // If anything fails catastrophically, return empty string
    // This ensures the user's message still gets sent
    return "";
  }
}
