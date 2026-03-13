// src/cli/helpers/sessionContext.ts
// Generates session context system reminder for the first message of each CLI session
// Contains device/environment information only. Agent metadata is in agentMetadata.ts.

import { platform } from "node:os";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import { getVersion } from "../../version";
import { gatherGitContextSnapshot } from "./gitContext";

/**
 * Get the current local time in a human-readable format
 */
export function getLocalTime(): string {
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
export function getDeviceType(): string {
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
 * Gather git information if in a git repository
 * Returns truncated commits (3) and status (20 lines)
 * Each field is gathered independently with fallbacks
 */
function getGitInfo(): {
  isGitRepo: boolean;
  branch?: string;
  recentCommits?: string;
  status?: string;
  gitUser?: string;
} {
  const git = gatherGitContextSnapshot({
    recentCommitLimit: 3,
    recentCommitFormat: "%h %s (%an)",
    statusLineLimit: 20,
  });

  if (!git.isGitRepo) {
    return { isGitRepo: false };
  }

  return {
    isGitRepo: true,
    branch: git.branch ?? "(unknown)",
    recentCommits: git.recentCommits ?? "(failed to get commits)",
    status: git.status || "(clean working tree)",
    gitUser: git.gitUser ?? "(not configured)",
  };
}

/**
 * Build the session context system reminder (device/environment info only).
 * Agent metadata is handled separately by buildAgentMetadata().
 * Returns empty string on any failure (graceful degradation).
 */
export function buildSessionContext(): string {
  try {
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
- **Git user**: ${gitInfo.gitUser}

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

    context += SYSTEM_REMINDER_CLOSE;

    return context;
  } catch {
    // If anything fails catastrophically, return empty string
    // This ensures the user's message still gets sent
    return "";
  }
}
