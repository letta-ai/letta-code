/**
 * Lightweight local agent listing — reads agent JSON files from disk
 * without requiring the full LocalBackend or LocalStore to be instantiated.
 *
 * Used by the AgentSelector to show local agents regardless of current backend mode.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  isHiddenLocalAgentRecord,
  projectLocalAgentState,
} from "@/backend/local";
import type { LocalAgentRecord } from "@/backend/local/local-types";
import { getLocalBackendStorageDir } from "@/backend/local/paths";

/**
 * Read all local agent records from disk and project them to AgentState.
 * Returns an empty array if the local backend directory doesn't exist yet.
 */
export function listLocalAgentsFromDisk(): AgentState[] {
  const storageDir = getLocalBackendStorageDir();
  const agentsDir = join(storageDir, "agents");

  if (!existsSync(agentsDir)) return [];

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));

  const agents: { agent: AgentState; mtime: number }[] = [];
  for (const file of files) {
    try {
      const filePath = join(agentsDir, file);
      const raw = readFileSync(filePath, "utf8");
      const record = JSON.parse(raw) as LocalAgentRecord;
      if (isHiddenLocalAgentRecord(record)) continue;
      const mtime = statSync(filePath).mtimeMs;
      agents.push({
        agent: projectLocalAgentState(
          record,
          [],
          [],
          new Date(mtime).toISOString(),
        ),
        mtime,
      });
    } catch {
      // Skip malformed agent files
    }
  }

  // Sort by file mtime descending (most recently modified first)
  agents.sort((a, b) => b.mtime - a.mtime);

  return agents.map((a) => a.agent);
}
