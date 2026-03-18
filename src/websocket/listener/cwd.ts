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

export function getConversationWorkingDirectory(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): string {
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  return (
    runtime.workingDirectoryByConversation.get(scopeKey) ??
    runtime.bootWorkingDirectory
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
  if (workingDirectory === runtime.bootWorkingDirectory) {
    runtime.workingDirectoryByConversation.delete(scopeKey);
  } else {
    runtime.workingDirectoryByConversation.set(scopeKey, workingDirectory);
  }

  persistCwdMap(runtime.workingDirectoryByConversation);
}
