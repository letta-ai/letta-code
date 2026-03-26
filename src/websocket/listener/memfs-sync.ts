/**
 * Lazy memfs sync for listen mode.
 *
 * When the listener receives the first message for an agent, this module
 * checks whether the agent has the `git-memory-enabled` tag and, if so,
 * clones or pulls the memory repo so the Memory tool and $MEMORY_DIR work
 * correctly — mirroring what the local headless path does during bootstrap.
 */

import { debugLog, debugWarn } from "../../utils/debug";
import type { ListenerRuntime } from "./types";

/**
 * Core sync logic — fetches agent, checks tag, clones/pulls repo.
 */
async function syncMemfsForAgent(agentId: string): Promise<void> {
  const { getClient } = await import("../../agent/client");
  const client = await getClient();
  const agent = await client.agents.retrieve(agentId);

  const { GIT_MEMORY_ENABLED_TAG } = await import("../../agent/memoryGit");
  if (!agent.tags?.includes(GIT_MEMORY_ENABLED_TAG)) {
    debugLog(
      "memfs-sync",
      `Agent ${agentId} does not have memfs tag, skipping`,
    );
    return;
  }

  debugLog("memfs-sync", `Syncing memfs for agent ${agentId}`);

  const { applyMemfsFlags } = await import("../../agent/memoryFilesystem");
  await applyMemfsFlags(agentId, undefined, undefined, {
    pullOnExistingRepo: true,
    agentTags: agent.tags,
    skipPromptUpdate: true,
  });

  debugLog("memfs-sync", `Memfs sync complete for agent ${agentId}`);
}

/**
 * Ensure the memfs git repo is cloned/pulled for the given agent.
 *
 * No-ops if:
 * - The agent was already synced this session
 * - The agent doesn't have the `git-memory-enabled` tag
 *
 * Concurrent callers for the same agent coalesce onto a single in-flight
 * promise so turn ordering stays deterministic.
 *
 * Non-fatal: logs a warning on failure but doesn't throw.
 */
export async function ensureMemfsSyncedForAgent(
  listener: ListenerRuntime,
  agentId: string,
): Promise<void> {
  const existing = listener.memfsSyncedAgents.get(agentId);
  if (existing) {
    await existing;
    return;
  }

  const promise = syncMemfsForAgent(agentId).catch((err) => {
    // Non-fatal — agent can still process messages, just without local memory.
    debugWarn(
      "memfs-sync",
      `Failed to sync memfs for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Remove so next turn retries.
    listener.memfsSyncedAgents.delete(agentId);
  });

  listener.memfsSyncedAgents.set(agentId, promise);
  await promise;
}
