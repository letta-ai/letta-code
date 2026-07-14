import path from "node:path";
import { isConfirmedUnusableDirectory } from "@/helpers/usable-directory";
import {
  loadRemoteSettings,
  saveRemoteSettings,
  saveRemoteSettingsSync,
} from "./remote-settings";
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
  const stored = runtime.workingDirectoryByConversation.get(scopeKey);
  if (stored === undefined) {
    return runtime.bootWorkingDirectory;
  }

  // A persisted cwd can become stale if its directory was deleted (e.g. a
  // worktree that was cleaned up). Serving it would throw ENOENT on realpath
  // /process.chdir. Fall back to the boot dir and prune the dead entry so we
  // don't repeatedly serve it.
  if (isConfirmedUnusableDirectory(stored)) {
    runtime.workingDirectoryByConversation.delete(scopeKey);
    bumpWorkingDirectoryRevision(runtime);
    persistCwdMapSync(runtime.workingDirectoryByConversation);
    return runtime.bootWorkingDirectory;
  }

  return stored;
}

export function pruneStaleConversationWorkingDirectories(
  runtime: ListenerRuntime,
): boolean {
  const staleScopeKeys: string[] = [];
  for (const [
    scopeKey,
    workingDirectory,
  ] of runtime.workingDirectoryByConversation) {
    if (isConfirmedUnusableDirectory(workingDirectory)) {
      staleScopeKeys.push(scopeKey);
    }
  }

  if (staleScopeKeys.length === 0) {
    return false;
  }

  for (const scopeKey of staleScopeKeys) {
    runtime.workingDirectoryByConversation.delete(scopeKey);
  }
  bumpWorkingDirectoryRevision(runtime);
  persistCwdMapSync(runtime.workingDirectoryByConversation);
  return true;
}

export function bumpWorkingDirectoryRevision(runtime: ListenerRuntime): number {
  const revision = (runtime.workingDirectoryRevision ?? 0) + 1;
  runtime.workingDirectoryRevision = revision;
  return revision;
}

export function getExportedCwdMap(
  runtime: ListenerRuntime,
): Record<string, string> {
  pruneStaleConversationWorkingDirectories(runtime);
  return Object.fromEntries(runtime.workingDirectoryByConversation);
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

function persistCwdMapSync(map: Map<string, string>): void {
  saveRemoteSettingsSync({ cwdMap: Object.fromEntries(map) });
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

  bumpWorkingDirectoryRevision(runtime);
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
  bumpWorkingDirectoryRevision(runtime);
  persistCwdMap(runtime.workingDirectoryByConversation);
  return true;
}
