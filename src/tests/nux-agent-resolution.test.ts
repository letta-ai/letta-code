import { describe, expect, test } from "bun:test";
import {
  resolveStartupTarget,
  type StartupResolutionInput,
} from "../agent/resolve-startup-agent";

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
    localAgentId: null,
    localConversationId: null,
    localAgentExists: false,
    globalAgentId: null,
    globalAgentExists: false,
    mergedPinnedCount: 0,
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
        mergedPinnedCount: 3,
      }),
    );
    expect(result).toEqual({ action: "select" });
  });

  test("fresh dir + invalid global LRU + no pinned → create", () => {
    const result = resolveStartupTarget(
      makeInput({
        globalAgentId: "agent-global-deleted",
        globalAgentExists: false,
        mergedPinnedCount: 0,
      }),
    );
    expect(result).toEqual({ action: "create" });
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

  test("true fresh user (no local, no global, no pinned) → create", () => {
    const result = resolveStartupTarget(makeInput());
    expect(result).toEqual({ action: "create" });
  });

  test("no LRU but pinned agents exist → select", () => {
    const result = resolveStartupTarget(
      makeInput({
        mergedPinnedCount: 2,
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
    expect(result).toEqual({ action: "create" });
  });

  test("needsModelPicker + no valid agents → select (not create)", () => {
    const result = resolveStartupTarget(
      makeInput({
        needsModelPicker: true,
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
});
