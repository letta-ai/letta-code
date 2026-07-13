/**
 * Lazy memfs sync for listen mode.
 *
 * When the listener receives the first message for an agent, this module
 * checks whether the agent has the `git-memory-enabled` tag and, if so,
 * clones or pulls the memory repo so the Memory tool and $MEMORY_DIR work
 * correctly — mirroring what the local headless path does during bootstrap.
 */

import { debugLog, debugWarn } from "@/utils/debug";
import type { ListenerRuntime } from "./types";

/**
 * Core sync logic — fetches agent, checks tag, clones/pulls repo.
 */
async function syncMemfsForAgent(agentId: string): Promise<void> {
  const { settingsManager } = await import("@/settings-manager");
  if (settingsManager.isMemfsExplicitlyDisabled(agentId)) {
    // Worker-style agent deliberately created without a memfs (e.g. dream
    // reflectors) — its memory scope arrives per session via MEMORY_DIR.
    // Not a broken agent; do not "repair" it.
    debugLog(
      "memfs-sync",
      `Agent ${agentId} is explicitly memfs-disabled, skipping sync`,
    );
    return;
  }
  const { getBackend } = await import("@/backend");
  // `include: ["agent.tags"]` is required — without it the API can return
  // empty tags for a correctly tagged agent, which previously made the
  // listener skip the memfs clone and run the agent as a blank slate
  // (the Prod × DeepSeek incident).
  const agent = await getBackend().retrieveAgent(agentId, {
    include: ["agent.tags"],
  });

  const { GIT_MEMORY_ENABLED_TAG } = await import("@/agent/agent-tags");
  const { applyMemfsFlags, isLettaCloud } = await import(
    "@/agent/memory-filesystem"
  );

  if (!agent.tags?.includes(GIT_MEMORY_ENABLED_TAG)) {
    // An agent without the memfs tag on Letta Cloud is a bug, not a
    // configuration: some creation path skipped memfs setup. Repair it here
    // (tag + prompt + repo clone + legacy tool detach) instead of silently
    // running the agent without memory. Matches headless auto-enable behavior.
    if (!(await isLettaCloud())) {
      debugLog(
        "memfs-sync",
        `Agent ${agentId} does not have memfs tag (self-hosted), skipping`,
      );
      return;
    }
    console.warn(
      `[memfs-sync] Agent ${agentId} is missing the memfs tag on Letta Cloud — repairing (auto-enabling memfs).`,
    );
    await applyMemfsFlags(agentId, true, {
      pullOnExistingRepo: true,
      agentTags: agent.tags ?? [],
    });
    debugLog("memfs-sync", `Memfs repair complete for agent ${agentId}`);
    return;
  }

  debugLog("memfs-sync", `Syncing memfs for agent ${agentId}`);

  await applyMemfsFlags(agentId, undefined, {
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
