import type { ClientToolPolicy } from "@/types/protocol_v2";
import { getPermissionModeScopeKey } from "./permission-mode";
import type { ListenerRuntime } from "./types";

function getToolPolicyMap(
  runtime: ListenerRuntime,
): Map<string, ClientToolPolicy> {
  runtime.toolPolicyByConversation ??= new Map();
  return runtime.toolPolicyByConversation;
}

export function setConversationToolPolicy(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
  policy?: ClientToolPolicy,
): void {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  const toolPolicyMap = getToolPolicyMap(runtime);
  if (policy === undefined) {
    toolPolicyMap.delete(scopeKey);
    return;
  }
  toolPolicyMap.set(scopeKey, policy);
}

export function getConversationToolPolicy(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ClientToolPolicy | undefined {
  return getToolPolicyMap(runtime).get(
    getPermissionModeScopeKey(agentId, conversationId),
  );
}
