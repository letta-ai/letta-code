// src/cli/helpers/agentInfo.ts
// Generates agent info system reminder (agent identity, server, memory dir)

import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { LETTA_CLOUD_API_URL } from "../../auth/oauth";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import { settingsManager } from "../../settings-manager";

export interface AgentInfo {
  id: string;
  name: string | null;
  description?: string | null;
  lastRunAt?: string | null;
}

export interface AgentInfoOptions {
  agentInfo: AgentInfo;
  serverUrl?: string;
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
 * Build the agent info system reminder.
 * Contains agent identity information (ID, name, description, memory dir, server).
 * Returns empty string on any failure (graceful degradation).
 */
export function buildAgentInfo(options: AgentInfoOptions): string {
  try {
    const { agentInfo, serverUrl } = options;

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

    const showMemoryDir = (() => {
      try {
        return settingsManager.isMemfsEnabled(agentInfo.id);
      } catch {
        return false;
      }
    })();
    const memoryDirLine = showMemoryDir
      ? `\n- **Memory directory (also stored in \`MEMORY_DIR\` env var)**: \`${getMemoryFilesystemRoot(agentInfo.id)}\``
      : "";

    return `${SYSTEM_REMINDER_OPEN}This is an automated message providing information about you.
- **Agent ID (also stored in \`AGENT_ID\` env var)**: ${agentInfo.id}${memoryDirLine}
- **Agent name**: ${agentInfo.name || "(unnamed)"} (the user can change this with /rename)
- **Agent description**: ${agentInfo.description || "(no description)"} (the user can change this with /description)
- **Last message**: ${lastRunInfo}
- **Server location**: ${actualServerUrl}
${SYSTEM_REMINDER_CLOSE}`;
  } catch {
    // If anything fails catastrophically, return empty string
    // This ensures the user's message still gets sent
    return "";
  }
}
