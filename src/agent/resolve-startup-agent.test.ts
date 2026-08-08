import { describe, expect, test } from "bun:test";
import {
  resolveStartupTarget,
  type StartupResolutionInput,
} from "@/agent/resolve-startup-agent";

/**
 * Unit tests for the NUX (new user experience) agent resolution logic.
 *
 * Core invariant: switching directories with a valid global LRU
 * should NOT create a new agent — it should resume the global agent.
 */

function makeInput(
  overrides: Partial<StartupResolutionInput> = {},
): StartupResolutionInput {
  return {
    pinnedAgentId: null,
    pinnedAgentExists: false,
    pinnedCount: 0,
    existingPinnedCount: 0,
    localAgentId: null,
    localConversationId: null,
    localAgentExists: false,
    globalAgentId: null,
    globalAgentExists: false,
    fallbackAgentId: null,
    fallbackConversationId: null,
    forceNew: false,
    needsModelPicker: false,
    ...overrides,
  };
}

describe("resolveStartupTarget", () => {
  test("fresh dir + valid global LRU → resumes global agent", () => {
    const result = resolveStartupTarget(
      makeInput({
        globalAgentId: "agent-global-123",
        globalAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-global-123",
    });
  });

  test("fresh dir + invalid global LRU + has pinned → select", () => {
    const result = resolveStartupTarget(
      makeInput({
        globalAgentId: "agent-global-deleted",
        globalAgentExists: false,
        pinnedCount: 3,
      }),
    );
    expect(result).toEqual({ action: "select" });
  });

  test("fresh dir + invalid global LRU + no pinned → create", () => {
    const result = resolveStartupTarget(
      makeInput({
        globalAgentId: "agent-global-deleted",
        globalAgentExists: false,
        pinnedCount: 0,
      }),
    );
    expect(result).toEqual({ action: "create", trigger: "fresh-start" });
  });

  test("dir with local LRU + valid agent → resumes local with conversation", () => {
    const result = resolveStartupTarget(
      makeInput({
        localAgentId: "agent-local-456",
        localConversationId: "conv-local-789",
        localAgentExists: true,
        globalAgentId: "agent-global-123",
        globalAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-local-456",
      conversationId: "conv-local-789",
    });
  });

  test("valid project LRU takes priority over a pinned agent", () => {
    const result = resolveStartupTarget(
      makeInput({
        pinnedAgentId: "agent-pinned-123",
        pinnedAgentExists: true,
        pinnedCount: 1,
        localAgentId: "agent-last-used-456",
        localConversationId: "conv-stale-789",
        localAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-last-used-456",
      conversationId: "conv-stale-789",
    });
  });

  test("project LRU preserves its conversation when the agent is also pinned", () => {
    const result = resolveStartupTarget(
      makeInput({
        pinnedAgentId: "agent-pinned-123",
        pinnedAgentExists: true,
        pinnedCount: 1,
        localAgentId: "agent-pinned-123",
        localConversationId: "conv-local-789",
        localAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-pinned-123",
      conversationId: "conv-local-789",
    });
  });

  test("project LRU resumes before the multiple-pin selector", () => {
    const result = resolveStartupTarget(
      makeInput({
        pinnedCount: 2,
        existingPinnedCount: 2,
        localAgentId: "agent-last-used-456",
        localConversationId: "conv-stale-789",
        localAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-last-used-456",
      conversationId: "conv-stale-789",
    });
  });

  test("multiple pins but only one exists → resume that pin (stale pins ignored)", () => {
    const result = resolveStartupTarget(
      makeInput({
        pinnedAgentId: "agent-pinned-live",
        pinnedAgentExists: true,
        pinnedCount: 3,
        existingPinnedCount: 1,
        localAgentId: "agent-last-used-missing",
        localAgentExists: false,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-pinned-live",
    });
  });

  test("multiple stale pins + valid global LRU → resume LRU, not select", () => {
    const result = resolveStartupTarget(
      makeInput({
        pinnedCount: 2,
        existingPinnedCount: 0,
        globalAgentId: "agent-global-123",
        globalAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-global-123",
    });
  });

  test("dir with local LRU + invalid agent + valid global → resumes global (no conv)", () => {
    const result = resolveStartupTarget(
      makeInput({
        localAgentId: "agent-local-deleted",
        localConversationId: "conv-local-789",
        localAgentExists: false,
        globalAgentId: "agent-global-123",
        globalAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-global-123",
    });
  });

  test("invalid local/global + backend-store fallback → resumes fallback conversation", () => {
    const result = resolveStartupTarget(
      makeInput({
        localAgentId: "agent-local-missing",
        localConversationId: "conv-missing",
        localAgentExists: false,
        globalAgentId: "agent-global-missing",
        globalAgentExists: false,
        fallbackAgentId: "agent-local-valid",
        fallbackConversationId: "conv-valid",
      }),
    );

    expect(result).toEqual({
      action: "resume",
      agentId: "agent-local-valid",
      conversationId: "conv-valid",
    });
  });

  test("valid global LRU takes priority over backend-store fallback", () => {
    const result = resolveStartupTarget(
      makeInput({
        globalAgentId: "agent-global-valid",
        globalAgentExists: true,
        fallbackAgentId: "agent-local-valid",
        fallbackConversationId: "conv-valid",
      }),
    );

    expect(result).toEqual({
      action: "resume",
      agentId: "agent-global-valid",
    });
  });

  test("true fresh user (no local, no global, no pinned) → create", () => {
    const result = resolveStartupTarget(makeInput());
    expect(result).toEqual({ action: "create", trigger: "fresh-start" });
  });

  test("no LRU but pinned agents exist → select", () => {
    const result = resolveStartupTarget(
      makeInput({
        pinnedCount: 2,
      }),
    );
    expect(result).toEqual({ action: "select" });
  });

  test("forceNew = true → create (even with valid LRU)", () => {
    const result = resolveStartupTarget(
      makeInput({
        localAgentId: "agent-local-456",
        localAgentExists: true,
        globalAgentId: "agent-global-123",
        globalAgentExists: true,
        forceNew: true,
      }),
    );
    expect(result).toEqual({ action: "create", trigger: "force-new" });
  });

  test("needsModelPicker + no valid agents → select (not create)", () => {
    const result = resolveStartupTarget(
      makeInput({
        needsModelPicker: true,
      }),
    );
    expect(result).toEqual({ action: "select" });
  });

  test("needsModelPicker takes priority over pinned selector", () => {
    const result = resolveStartupTarget(
      makeInput({
        needsModelPicker: true,
        pinnedCount: 5,
      }),
    );
    expect(result).toEqual({ action: "select" });
  });

  test("local LRU with null conversation → resumes without conversation", () => {
    const result = resolveStartupTarget(
      makeInput({
        localAgentId: "agent-local-456",
        localConversationId: null,
        localAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-local-456",
    });
  });

  test("global LRU never restores conversation (project-scoped)", () => {
    // Even if global session had a conversation, resolveStartupTarget
    // should NOT include it — conversations are project-scoped
    const result = resolveStartupTarget(
      makeInput({
        globalAgentId: "agent-global-123",
        globalAgentExists: true,
      }),
    );
    expect(result).toEqual({
      action: "resume",
      agentId: "agent-global-123",
    });
    // Verify no conversationId key (not even undefined)
    expect("conversationId" in result).toBe(false);
  });

  test("same local/global ID invalid + no pinned → create", () => {
    const result = resolveStartupTarget(
      makeInput({
        localAgentId: "agent-same",
        localAgentExists: false,
        globalAgentId: "agent-same",
        globalAgentExists: false,
        pinnedCount: 0,
      }),
    );
    expect(result).toEqual({ action: "create", trigger: "fresh-start" });
  });

  test("same local/global ID invalid + pinned → select", () => {
    const result = resolveStartupTarget(
      makeInput({
        localAgentId: "agent-same",
        localAgentExists: false,
        globalAgentId: "agent-same",
        globalAgentExists: false,
        pinnedCount: 1,
      }),
    );
    expect(result).toEqual({ action: "select" });
  });
});
