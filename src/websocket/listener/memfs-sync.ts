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
  } catch {}
}

async function syncMemfsForAgent(agentId: string): Promise<void> {
  const { settingsManager } = await import("@/settings-manager");
  if (settingsManager.isMemfsExplicitlyDisabled(agentId)) {
    debugLog(
      "memfs-sync",
      `Agent ${agentId} is explicitly memfs-disabled, skipping sync`,
    );
    return;
  }
  const { getBackend } = await import("@/backend");
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
      debugLog("memfs-sync", `Agent ${agentId} is a subagent, skipping repair`);
      return;
    }
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
      debugWarn(
        "memfs-sync",
        `Failed to sync memfs for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (isMemoryAccessRefusal(err)) {
        await removeRefusedCheckout(agentId, err);
        markMemoryUnavailable(agentId);
      } else {
        listener.memfsSyncedAgents.delete(agentId);
      }
      return false;
    },
  );

  listener.memfsSyncedAgents.set(agentId, promise);
  return promise;
}
