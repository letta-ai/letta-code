import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import type { SkillSource } from "@/agent/skill-sources";
import { settingsManager } from "@/settings-manager";
import type { ConversationRuntime } from "./types";

const STATELESS_DEFAULT_SKILL_SOURCES: SkillSource[] = [
  "bundled",
  "global",
  "project",
];

export function setConversationRuntimeStateless(
  runtime: ConversationRuntime,
  stateless: boolean,
): void {
  runtime.stateless = stateless;
  let statelessScopes = runtime.listener.statelessByConversation;
  if (!statelessScopes) {
    statelessScopes = new Set();
    runtime.listener.statelessByConversation = statelessScopes;
  }
  if (stateless) {
    statelessScopes.add(runtime.key);
  } else {
    statelessScopes.delete(runtime.key);
  }
}

export function isConversationMemfsEnabled(
  runtime: ConversationRuntime,
): boolean {
  return (
    !runtime.stateless &&
    runtime.agentId !== null &&
    settingsManager.isMemfsEnabled(runtime.agentId)
  );
}

export function getConversationMemoryDirectory(
  runtime: ConversationRuntime,
): string | null {
  return isConversationMemfsEnabled(runtime) && runtime.agentId
    ? getScopedMemoryFilesystemRoot(runtime.agentId)
    : null;
}

export function runtimeMemoryDir(
  runtime: ConversationRuntime | null,
  agentId: string | null,
): string | null {
  return agentId && runtime?.stateless !== true
    ? getScopedMemoryFilesystemRoot(agentId)
    : null;
}

export function getConversationSkillSources(
  runtime: ConversationRuntime,
): SkillSource[] | undefined {
  if (!runtime.stateless) {
    return runtime.skillSources;
  }
  return (runtime.skillSources ?? STATELESS_DEFAULT_SKILL_SOURCES).filter(
    (source) => source !== "agent",
  );
}
