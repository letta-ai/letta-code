/**
 * Per-conversation permission mode storage.
 *
 * Mirrors the CWD isolation pattern in cwd.ts:
 * - State is stored in a Map on the long-lived ListenerRuntime (not on the
 *   ephemeral ConversationRuntime, which gets evicted between turns).
 * - A scope key derived from agentId + conversationId is used as the map key.
 */

import {
  DEFAULT_PERMISSION_MODE,
  permissionMode as globalPermissionMode,
  migratePermissionMode,
  type PermissionMode,
} from "@/permissions/mode";
import { loadRemoteSettings, saveRemoteSettings } from "./remote-settings";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerRuntime } from "./types";

export type ConversationPermissionModeState = {
  mode: PermissionMode;
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

function createDefaultPermissionModeState(): ConversationPermissionModeState {
  return {
    mode: globalPermissionMode.getMode(),
  };
}

function isPrunableDefaultState(
  state: ConversationPermissionModeState,
): boolean {
  return state.mode === globalPermissionMode.getMode();
}

/**
 * Read-only state lookup for a conversation scope.
 *
 * This helper is intended for read paths (status rendering, serialization).
 * It does not materialize new map entries for missing scopes.
 */
export function getConversationPermissionModeState(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): Readonly<ConversationPermissionModeState> {
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
      const normalizedAgentId = normalizeCwdAgentId(agentId);
      if (normalizedAgentId) {
        runtime.permissionModeByConversation.set(scopeKey, legacyDefault);
        runtime.permissionModeByConversation.delete(legacyDefaultKey);
      }
      return legacyDefault;
    }
  }

  return createDefaultPermissionModeState();
}

/**
 * Returns the canonical mutable state object for a conversation scope.
 *
 * This helper materializes missing entries and guarantees stable identity
 * during a turn so concurrent mode updates (websocket + tool mutations)
 * apply to the same object reference.
 */
export function getOrCreateConversationPermissionModeStateRef(
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

  if (normalizedConversationId === "default") {
    const legacyDefaultKey = getPermissionModeScopeKey(null, "default");
    const legacyDefault =
      runtime.permissionModeByConversation.get(legacyDefaultKey);
    if (legacyDefault) {
      const normalizedAgentId = normalizeCwdAgentId(agentId);
      if (normalizedAgentId) {
        runtime.permissionModeByConversation.set(scopeKey, legacyDefault);
        runtime.permissionModeByConversation.delete(legacyDefaultKey);
      }
      return legacyDefault;
    }
  }

  const created = createDefaultPermissionModeState();
  runtime.permissionModeByConversation.set(scopeKey, created);
  return created;
}

/**
 * Remove a canonical state entry when it is equivalent to the default state.
 *
 * This should be called at turn finalization boundaries, not on each mode
 * update, to avoid breaking object identity for in-flight turns.
 */
export function pruneConversationPermissionModeStateIfDefault(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): boolean {
  const scopeKey = getPermissionModeScopeKey(agentId, conversationId);
  const state = runtime.permissionModeByConversation.get(scopeKey);
  if (!state) {
    return false;
  }
  if (!isPrunableDefaultState(state)) {
    return false;
  }
  runtime.permissionModeByConversation.delete(scopeKey);
  return true;
}

/**
 * Load the persisted permission mode map from remote-settings.json.
 * Converts PersistedPermissionModeState → ConversationPermissionModeState.
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
      // Migrate legacy mode values ("default" → "standard", "bypassPermissions" → "unrestricted").
      const rawMode =
        migratePermissionMode(persisted.mode) ?? DEFAULT_PERMISSION_MODE;
      map.set(key, {
        mode: rawMode,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Persist permission mode map to remote-settings.json.
 */
export function persistPermissionModeMapForRuntime(
  runtime: ListenerRuntime,
): void {
  persistPermissionModeMap(runtime.permissionModeByConversation);
}

/**
 * Serialize the permission mode map and persist to remote-settings.json.
 * Skips entries that match the current global default mode (lean map).
 */
function persistPermissionModeMap(
  map: Map<string, ConversationPermissionModeState>,
): void {
  const permissionModeMap: Record<string, { mode: PermissionMode }> = {};

  for (const [key, state] of map) {
    // Skip entries that are just the default starting mode with no context — lean map.
    if (state.mode === DEFAULT_PERMISSION_MODE) {
      continue;
    }

    permissionModeMap[key] = {
      mode: state.mode,
    };
  }

  saveRemoteSettings({ permissionModeMap });
}
