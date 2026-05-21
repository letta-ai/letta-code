/**
 * Lightweight local agent listing — reads agent JSON files from disk
 * without requiring the full LocalBackend or LocalStore to be instantiated.
 *
 * Used by the AgentSelector to show local agents regardless of current backend mode.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
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
      const mtime = statSync(filePath).mtimeMs;
      agents.push({ agent: projectLocalAgent(record, mtime), mtime });
    } catch {
      // Skip malformed agent files
    }
  }

  // Sort by file mtime descending (most recently modified first)
  agents.sort((a, b) => b.mtime - a.mtime);

  return agents.map((a) => a.agent);
}

/**
 * Project a LocalAgentRecord to an AgentState (subset of fields needed for display).
 * Mirrors projectAgentState from local-store.ts but simplified for listing.
 */
function projectLocalAgent(
  record: LocalAgentRecord,
  mtimeMs?: number,
): AgentState {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    system: record.system,
    tools: [],
    tags: record.tags,
    model: record.model,
    model_settings: record.model_settings,
    ...(record.compaction_settings !== undefined
      ? { compaction_settings: record.compaction_settings }
      : {}),
    llm_config: {
      model: record.model,
      model_endpoint_type: "openai",
      model_endpoint: "https://example.invalid/v1",
      context_window:
        typeof record.model_settings.context_window_limit === "number"
          ? record.model_settings.context_window_limit
          : 128000,
    },
    ...(mtimeMs
      ? { last_run_completion: new Date(mtimeMs).toISOString() }
      : {}),
  } as unknown as AgentState;
}
