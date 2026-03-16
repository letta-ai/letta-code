import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerRuntime } from "./types";

const shouldPersistCwd = process.env.PERSIST_CWD === "1";

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

export function getCwdCachePath(): string {
  return path.join(homedir(), ".letta", "cwd-cache.json");
}

export function loadPersistedCwdMap(): Map<string, string> {
  if (!shouldPersistCwd) return new Map();
  try {
    const cachePath = getCwdCachePath();
    if (!existsSync(cachePath)) return new Map();
    const raw = require("node:fs").readFileSync(cachePath, "utf-8") as string;
    const parsed = JSON.parse(raw) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && existsSync(value)) {
        map.set(key, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function persistCwdMap(map: Map<string, string>): void {
  if (!shouldPersistCwd) return;
  const cachePath = getCwdCachePath();
  const obj: Record<string, string> = Object.fromEntries(map);
  void mkdir(path.dirname(cachePath), { recursive: true })
    .then(() => writeFile(cachePath, JSON.stringify(obj, null, 2)))
    .catch(() => {
      // Silently ignore write failures.
    });
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
