/**
 * Per-conversation permission mode storage.
 *
 * Mirrors the CWD isolation pattern in cwd.ts:
 * - State is stored in a Map on the long-lived ListenerRuntime (not on the
 *   ephemeral ConversationRuntime, which gets evicted between turns).
 * - A scope key derived from agentId + conversationId is used as the map key.
 */

import type { PermissionMode } from "../../permissions/mode";
import { permissionMode as globalPermissionMode } from "../../permissions/mode";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerRuntime } from "./types";

export type ConversationPermissionModeState = {
  mode: PermissionMode;
  planFilePath: string | null;
  modeBeforePlan: PermissionMode | null;
};

export function getPermissionModeScopeKey(
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

export function getConversationPermissionModeState(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationPermissionModeState {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  return (
    runtime.permissionModeByConversation.get(scopeKey) ?? {
      mode: globalPermissionMode.getMode(),
      planFilePath: null,
      modeBeforePlan: null,
    }
  );
}

export function setConversationPermissionModeState(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
  state: ConversationPermissionModeState,
): void {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  // Only store if different from the global default to keep the map lean.
  if (
    state.mode === globalPermissionMode.getMode() &&
    state.planFilePath === null &&
    state.modeBeforePlan === null
  ) {
    runtime.permissionModeByConversation.delete(scopeKey);
  } else {
    runtime.permissionModeByConversation.set(scopeKey, { ...state });
  }
}
