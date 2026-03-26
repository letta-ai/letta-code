// src/cli/helpers/sessionContext.ts
// Generates session context system reminder for the first message of each CLI session
// Contains device/environment information only. Agent metadata is in agentMetadata.ts.

import { platform } from "node:os";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import type { SessionContextReason } from "../../reminders/state";
import { getVersion } from "../../version";
import { gatherGitContextSnapshot } from "./gitContext";

export type SessionContextSource = "interactive-cli" | "headless" | "listen";

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
function getGitInfo(cwd?: string): {
  isGitRepo: boolean;
  branch?: string;
  recentCommits?: string;
  status?: string;
  gitUser?: string;
} {
  const git = gatherGitContextSnapshot({
    cwd,
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

export interface BuildSessionContextOptions {
  cwd?: string;
  source?: SessionContextSource;
  reason?: SessionContextReason;
}

function getIntroText(
  source: SessionContextSource,
  reason: SessionContextReason,
): string {
  if (reason === "cwd_changed") {
    return "The working directory for this conversation has changed. Updated environment context follows.";
  }
  switch (source) {
    case "listen":
      return "This conversation is now connected to a Letta Code execution environment.";
    case "headless":
      return "The user has just initiated a new connection via the Letta Code headless client.";
    default:
      return "The user has just initiated a new connection via the [Letta Code CLI client](https://docs.letta.com/letta-code/index.md).";
  }
}

/**
 * Build the session context system reminder (device/environment info only).
 * Agent metadata is handled separately by buildAgentMetadata().
 * Returns empty string on any failure (graceful degradation).
 */
export function buildSessionContext(
  options?: BuildSessionContextOptions,
): string {
  try {
    const cwd = options?.cwd ?? process.cwd();
    const source = options?.source ?? "interactive-cli";
    const reason = options?.reason ?? "initial_attach";

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

    const gitInfo = getGitInfo(cwd);

    // Build the context
    let context = `${SYSTEM_REMINDER_OPEN}
This is an automated message providing context about the user's environment.
${getIntroText(source, reason)}

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
