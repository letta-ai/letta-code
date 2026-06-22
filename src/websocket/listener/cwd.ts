import path from "node:path";
import { loadRemoteSettings, saveRemoteSettings } from "./remote-settings";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerRuntime } from "./types";

export function getWorkingDirectoryScopeKey(
  agentId?: string | null,
  conversationId?: string | null,
): string {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const normalizedAgentId = normalizeCwdAgentId(agentId);
  if (normalizedConversationId === "default") {
    return `agent:${normalizedAgentId ?? "__unknown__"}::conversation:default`;
  }

  return `conversation:${normalizedConversationId}`;
}

/**
 * The directory a scope inherits when it has no explicit per-scope override.
 *
 * For a concrete conversation this is the agent's saved "default working
 * directory" (the folder chosen via the desktop "Default working directory"
 * dialog, stored under the `agent:<id>::conversation:default` scope key), and
 * only the boot directory when no such default exists. For the agent-default
 * scope itself (conversationId === "default") there is no higher tier, so it
 * inherits the boot directory directly.
 *
 * Without this, a saved per-agent default only ever applied to the pre-send
 * "default" conversation preview: once a real conversation id was created its
 * scope key had no entry and resolution fell straight back to the boot cwd, so
 * every new chat silently ignored the saved default.
 */
function getInheritedWorkingDirectory(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): string {
  if (normalizeConversationId(conversationId) !== "default") {
    const agentDefault = runtime.workingDirectoryByConversation.get(
      getWorkingDirectoryScopeKey(agentId, "default"),
    );
    if (agentDefault !== undefined) {
      return agentDefault;
    }
  }
  return runtime.bootWorkingDirectory;
}

export function getConversationWorkingDirectory(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): string {
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  return (
    runtime.workingDirectoryByConversation.get(scopeKey) ??
    getInheritedWorkingDirectory(runtime, agentId, conversationId)
  );
}

/**
 * @deprecated - the legacy path is only read for one-time migration in remote-settings.ts
 */
export function getCwdCachePath(): string {
  return path.join(
    process.env.HOME ?? require("node:os").homedir(),
    ".letta",
    "cwd-cache.json",
  );
}

export function loadPersistedCwdMap(): Map<string, string> {
  try {
    const settings = loadRemoteSettings();
    const map = new Map<string, string>();
    if (settings.cwdMap) {
      for (const [key, value] of Object.entries(settings.cwdMap)) {
        map.set(key, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function persistCwdMap(map: Map<string, string>): void {
  saveRemoteSettings({ cwdMap: Object.fromEntries(map) });
}

export function setConversationWorkingDirectory(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
  workingDirectory: string,
): void {
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  // Only persist an explicit override when it differs from what the scope
  // would already inherit (the per-agent default, else the boot directory).
  // This keeps the map free of redundant entries while ensuring an explicit
  // choice that differs from the inherited default is preserved.
  const inherited = getInheritedWorkingDirectory(
    runtime,
    agentId,
    conversationId,
  );
  if (workingDirectory === inherited) {
    runtime.workingDirectoryByConversation.delete(scopeKey);
  } else {
    runtime.workingDirectoryByConversation.set(scopeKey, workingDirectory);
  }

  persistCwdMap(runtime.workingDirectoryByConversation);
}

export function seedConversationWorkingDirectory(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
  workingDirectory: string,
): boolean {
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  if (runtime.workingDirectoryByConversation.has(scopeKey)) {
    return false;
  }

  runtime.workingDirectoryByConversation.set(scopeKey, workingDirectory);
  persistCwdMap(runtime.workingDirectoryByConversation);
  return true;
}
