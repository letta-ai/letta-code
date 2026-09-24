import { describe, expect, test } from "bun:test";
import { createSessionRotationHandler } from "./new-conversation";

// Guard-path coverage for the session rotation handler. The guards must
// throw BEFORE any conversation is created, so none of these need a backend:
// reaching conversation creation would throw a backend-unavailable error
// instead of the guard's message.

function createDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      agentId: "agent-1",
      agentIdRef: { current: "agent-1" },
      conversationIdRef: { current: "conv-active" },
      isAgentBusy: () => false,
      queuedOverlayAction: null,
      setQueuedOverlayAction: () => {
        calls.push("queue");
      },
      bind: async () => {
        calls.push("bind");
      },
      ...overrides,
    } as Parameters<typeof createSessionRotationHandler>[0],
  };
}

describe("createSessionRotationHandler guards", () => {
  test("rejects a rotation for a different agent", async () => {
    const { deps } = createDeps();
    const handler = createSessionRotationHandler(deps);
    await expect(handler({ agentId: "agent-other" })).rejects.toThrow(
      "agent agent-other is not the active session agent",
    );
  });

  test("rejects a stale conversation handle before creating anything", async () => {
    const { calls, deps } = createDeps({ isAgentBusy: () => true });
    const handler = createSessionRotationHandler(deps);
    await expect(handler({ conversationId: "conv-stale" })).rejects.toThrow(
      "conversation conv-stale is no longer the active session conversation",
    );
    expect(calls).toEqual([]);
  });

  test("allows the active conversation and the default alias", async () => {
    const { deps } = createDeps({ isAgentBusy: () => true });
    const handler = createSessionRotationHandler(deps);
    // Both reach the queue path without a stale-handle rejection; they fail
    // later at conversation creation (no backend in this test), which proves
    // the guard let them through.
    await expect(handler({ conversationId: "conv-active" })).rejects.toThrow();
    await expect(handler({ conversationId: "default" })).rejects.toThrow();
  });

  test("rejects queueing when a user action already holds the queued slot", async () => {
    const { calls, deps } = createDeps({
      isAgentBusy: () => true,
      queuedOverlayAction: {
        type: "switch_model",
        modelId: "anthropic/claude-opus-4-8",
      },
    });
    const handler = createSessionRotationHandler(deps);
    await expect(handler({})).rejects.toThrow(
      "the session already has a queued action pending",
    );
    expect(calls).toEqual([]);
  });
});
