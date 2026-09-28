import { describe, expect, spyOn, test } from "bun:test";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import {
  effectiveRemotePermissionModeState,
  getConversationPermissionModeState,
  getOrCreateConversationPermissionModeStateRef,
  getPermissionModeScopeKey,
  pruneConversationPermissionModeStateIfDefault,
  warnIfRemoteAutoMode,
} from "@/websocket/listener/permission-mode";
import { isRuntimeStartCommand } from "@/websocket/listener/runtime-start-validation";

describe("listener permission mode helpers", () => {
  test("runtime_start accepts auto mode", () => {
    expect(
      isRuntimeStartCommand({
        type: "runtime_start",
        request_id: "r1",
        agent_id: "agent-1",
        mode: "auto",
      }),
    ).toBe(true);
  });
  test("remote auto selection warns that unresolved approvals require explicit consent", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnIfRemoteAutoMode("auto");
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "unresolved tool approvals require explicit approval",
        ),
      );
      warning.mockClear();
      warnIfRemoteAutoMode("standard");
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  test("remote Auto is standard for both live and recovered approval checks", () => {
    const selected = { mode: "auto" as const };
    expect(effectiveRemotePermissionModeState(selected)).toEqual({
      mode: "standard",
    });
    expect(selected.mode).toBe("auto");
    const ordinary = { mode: "acceptEdits" as const };
    expect(effectiveRemotePermissionModeState(ordinary)).toBe(ordinary);
  });
  test("getOrCreate ref preserves identity across legacy default-key migration", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const legacyKey = getPermissionModeScopeKey(null, "default");

    const legacyState = {
      mode: "acceptEdits" as const,
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
    ref2.mode = "acceptEdits";

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
