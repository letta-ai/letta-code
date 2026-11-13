/**
 * Lazy memfs sync for listen mode.
 *
 * When the listener receives the first message for an agent, this module
 * checks whether the agent has the `git-memory-enabled` tag and, if so,
 * clones or pulls the memory repo so the Memory tool and $MEMORY_DIR work
 * correctly — mirroring what the local headless path does during bootstrap.
 */

import { execFileSync } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";
import { debugLog, debugWarn } from "@/utils/debug";
import {
  isMemoryAccessRefusal,
  isMemoryUnavailable,
  markMemoryUnavailable,
} from "@/utils/memory-access";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import type { ListenerRuntime } from "./types";

/** Remove only a verified agent checkout after an explicit HTTP 403. */
async function removeRefusedCheckout(
  agentId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (
    isLocalBackendEnvEnabled() ||
    !/(?:returned error:|HTTP(?: status)?)[ :]*403\b/i.test(message)
  )
    return;

  try {
    const { getScopedMemoryFilesystemRoot } = await import(
      "@/agent/memory-filesystem"
    );
    const { isMemfsRemoteUrlForAgent } = await import("@/agent/memory-git");
    const configDir = await realpath(resolveGlobalConfigDir());
    if (
      !agentId ||
      agentId === "." ||
      agentId === ".." ||
      /[/\\]/.test(agentId)
    )
      return;
    const expected = join(configDir, "agents", agentId, "memory");
    const checkout = resolve(getScopedMemoryFilesystemRoot(agentId));
    // Reject redirected parents and symlinks, including another agent's checkout.
    if (
      (await realpath(checkout)) !== expected ||
      !(await lstat(checkout)).isDirectory()
    )
      return;
    const cwdRelative = relative(expected, await realpath(process.cwd()));
    if (
      !cwdRelative ||
      (!cwdRelative.startsWith(`..${sep}`) &&
        cwdRelative !== ".." &&
        !isAbsolute(cwdRelative))
    )
      return;
    if (!(await lstat(join(checkout, ".git"))).isDirectory()) return;
    const origin = execFileSync(
      "git",
      ["-C", checkout, "remote", "get-url", "origin"],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!isMemfsRemoteUrlForAgent(origin, agentId)) return;
    await rm(checkout, { recursive: true, force: true });
  } catch {
    // Missing or unverifiable checkouts are left alone; access is still disabled.
  }
}

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

  const { GIT_MEMORY_ENABLED_TAG, isStatelessSubagentTags } = await import(
    "@/agent/agent-tags"
  );
  const { applyMemfsFlags, isLettaCloud } = await import(
    "@/agent/memory-filesystem"
  );

  if (!agent.tags?.includes(GIT_MEMORY_ENABLED_TAG)) {
    if (isStatelessSubagentTags(agent.tags)) {
      // Subagents are stateless by design, not a broken creation path.
      debugLog("memfs-sync", `Agent ${agentId} is a subagent, skipping repair`);
      return;
    }
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
    debugWarn(
      "memfs-sync",
      `Agent ${agentId} is missing the memfs tag on Letta Cloud — repairing (auto-enabling memfs).`,
    );
    await applyMemfsFlags(agentId, true, {
      pullOnExistingRepo: true,
      throwOnPullFailure: true,
      agentTags: agent.tags ?? [],
    });
    debugLog("memfs-sync", `Memfs repair complete for agent ${agentId}`);
    return;
  }

  debugLog("memfs-sync", `Syncing memfs for agent ${agentId}`);

  await applyMemfsFlags(agentId, undefined, {
    pullOnExistingRepo: true,
    throwOnPullFailure: true,
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
 * Non-fatal: logs a warning and returns false on failure so source consumers
 * do not read a stale checkout.
 */
export async function ensureMemfsSyncedForAgent(
  listener: ListenerRuntime,
  agentId: string,
): Promise<boolean> {
  if (isMemoryUnavailable(agentId)) return false;
  const existing = listener.memfsSyncedAgents.get(agentId);
  if (existing) {
    return existing;
  }

  const promise = syncMemfsForAgent(agentId).then(
    () => true,
    async (err) => {
      // Non-fatal — agent can still process messages, just without local memory.
      debugWarn(
        "memfs-sync",
        `Failed to sync memfs for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (isMemoryAccessRefusal(err)) {
        await removeRefusedCheckout(agentId, err);
        markMemoryUnavailable(agentId);
      } else {
        // Transient failures may succeed on the next turn.
        listener.memfsSyncedAgents.delete(agentId);
      }
      return false;
    },
  );

  listener.memfsSyncedAgents.set(agentId, promise);
  return promise;
}
