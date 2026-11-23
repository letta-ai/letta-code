import {
  DEFAULT_PERMISSION_MODE,
  permissionMode as globalPermissionMode,
  migratePermissionMode,
  type PermissionMode,
} from "@/permissions/mode";
import {
  loadRemoteSettings,
  type PersistedPermissionModeState,
  saveRemoteSettings,
} from "./remote-settings";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerRuntime } from "./types";

export type ConversationPermissionModeState = {
  mode: PermissionMode;
  explicit?: boolean;
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
  return !state.explicit && state.mode === globalPermissionMode.getMode();
}

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
      const rawMode =
        migratePermissionMode(persisted.mode) ?? DEFAULT_PERMISSION_MODE;
      map.set(key, {
        mode: rawMode,
        ...(persisted.explicit ? { explicit: true } : {}),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

export function persistPermissionModeMapForRuntime(
  runtime: ListenerRuntime,
): void {
  persistPermissionModeMap(runtime.permissionModeByConversation);
}

function persistPermissionModeMap(
  map: Map<string, ConversationPermissionModeState>,
): void {
  const permissionModeMap: Record<string, PersistedPermissionModeState> = {};

  for (const [key, state] of map) {
    if (!state.explicit && state.mode === DEFAULT_PERMISSION_MODE) {
      continue;
    }

    permissionModeMap[key] = {
      mode: state.mode,
      ...(state.explicit ? { explicit: true } : {}),
    };
  }

  saveRemoteSettings({ permissionModeMap });
}
