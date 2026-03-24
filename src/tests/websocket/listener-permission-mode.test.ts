import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "../../websocket/listen-client";
import {
  getConversationPermissionModeState,
  getOrCreateConversationPermissionModeStateRef,
  getPermissionModeScopeKey,
  pruneConversationPermissionModeStateIfDefault,
} from "../../websocket/listener/permissionMode";

describe("listener permission mode helpers", () => {
  test("getOrCreate ref preserves identity across legacy default-key migration", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const legacyKey = getPermissionModeScopeKey(null, "default");

    const legacyState = {
      mode: "acceptEdits" as const,
      planFilePath: null,
      modeBeforePlan: null,
    };
    listener.permissionModeByConversation.set(legacyKey, legacyState);

    const canonicalRef = getOrCreateConversationPermissionModeStateRef(
      listener,
      "agent-123",
      "default",
    );

    expect(canonicalRef).toBe(legacyState);
    expect(listener.permissionModeByConversation.has(legacyKey)).toBe(false);
    expect(
      listener.permissionModeByConversation.get(
        getPermissionModeScopeKey("agent-123", "default"),
      ),
    ).toBe(legacyState);
  });

  test("read getter returns default snapshot without materializing map entry", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const scopeKey = getPermissionModeScopeKey("agent-xyz", "conv-1");

    const state = getConversationPermissionModeState(
      listener,
      "agent-xyz",
      "conv-1",
    );

    expect(state.mode).toBeDefined();
    expect(listener.permissionModeByConversation.has(scopeKey)).toBe(false);
  });

  test("prune removes only default-equivalent canonical entries", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const ref = getOrCreateConversationPermissionModeStateRef(
      listener,
      "agent-1",
      "conv-prune",
    );

    const prunedDefault = pruneConversationPermissionModeStateIfDefault(
      listener,
      "agent-1",
      "conv-prune",
    );
    expect(prunedDefault).toBe(true);
    expect(
      listener.permissionModeByConversation.has(
        getPermissionModeScopeKey("agent-1", "conv-prune"),
      ),
    ).toBe(false);

    const ref2 = getOrCreateConversationPermissionModeStateRef(
      listener,
      "agent-1",
      "conv-prune",
    );
    ref2.mode = "bypassPermissions";

    const prunedNonDefault = pruneConversationPermissionModeStateIfDefault(
      listener,
      "agent-1",
      "conv-prune",
    );
    expect(prunedNonDefault).toBe(false);
    expect(
      listener.permissionModeByConversation.get(
        getPermissionModeScopeKey("agent-1", "conv-prune"),
      ),
    ).toBe(ref2);

    // keep typechecker happy about intentionally unused ref
    expect(ref).toBeDefined();
  });
});
