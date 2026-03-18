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
import { loadRemoteSettings, saveRemoteSettings } from "./remote-settings";
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
  const normalizedConversationId = normalizeConversationId(conversationId);

  const direct = runtime.permissionModeByConversation.get(scopeKey);
  if (direct) {
    return direct;
  }

  // Backward/interop fallback for default-conversation entries that were
  // keyed without an agent id (agent:__unknown__). If we find one while a
  // concrete agent id is available, migrate it to the canonical key.
  if (normalizedConversationId === "default") {
    const legacyDefaultKey = getPermissionModeScopeKey(null, "default");
    const legacyDefault =
      runtime.permissionModeByConversation.get(legacyDefaultKey);
    if (legacyDefault) {
      if (normalizeCwdAgentId(agentId)) {
        runtime.permissionModeByConversation.set(scopeKey, {
          ...legacyDefault,
        });
        runtime.permissionModeByConversation.delete(legacyDefaultKey);
      }
      return legacyDefault;
    }
  }

  return {
    mode: globalPermissionMode.getMode(),
    planFilePath: null,
    modeBeforePlan: null,
  };
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

  persistPermissionModeMap(runtime.permissionModeByConversation);
}

/**
 * Load the persisted permission mode map from remote-settings.json.
 * Converts PersistedPermissionModeState → ConversationPermissionModeState,
 * restoring planFilePath as null (ephemeral — not persisted across restarts).
 * If persisted mode was "plan", restores modeBeforePlan instead.
 */
export function loadPersistedPermissionModeMap(): Map<
  string,
  ConversationPermissionModeState
> {
  try {
    const settings = loadRemoteSettings();
    const map = new Map<string, ConversationPermissionModeState>();
    if (!settings.permissionModeMap) {
      return map;
    }
    for (const [key, persisted] of Object.entries(settings.permissionModeMap)) {
      // If "plan" was somehow saved, restore to the pre-plan mode.
      const restoredMode: PermissionMode =
        persisted.mode === "plan"
          ? (persisted.modeBeforePlan ?? "default")
          : persisted.mode;
      map.set(key, {
        mode: restoredMode,
        planFilePath: null,
        modeBeforePlan: null,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Serialize the permission mode map and persist to remote-settings.json.
 * Strips planFilePath (ephemeral). Converts "plan" mode to modeBeforePlan.
 * Skips entries that are effectively "default" (lean map).
 */
function persistPermissionModeMap(
  map: Map<string, ConversationPermissionModeState>,
): void {
  const permissionModeMap: Record<
    string,
    { mode: PermissionMode; modeBeforePlan: PermissionMode | null }
  > = {};

  for (const [key, state] of map) {
    // If currently in plan mode, persist the effective mode as modeBeforePlan
    // so we don't restore into plan mode (plan file path is ephemeral).
    const modeToSave: PermissionMode =
      state.mode === "plan" ? (state.modeBeforePlan ?? "default") : state.mode;

    // Skip entries that are just "default" with no context — lean map.
    if (modeToSave === "default" && state.modeBeforePlan === null) {
      continue;
    }

    permissionModeMap[key] = {
      mode: modeToSave,
      modeBeforePlan:
        state.mode === "plan" ? null : (state.modeBeforePlan ?? null),
    };
  }

  saveRemoteSettings({ permissionModeMap });
}
