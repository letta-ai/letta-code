import { beforeEach, describe, expect, mock, test } from "bun:test";

const conversationsRecompileMock = mock(
  (_conversationId: string, _params?: Record<string, unknown>) =>
    Promise.resolve("compiled-system-prompt"),
);

mock.module("../../agent/client", () => ({
  getClient: () => ({
    conversations: {
      recompile: conversationsRecompileMock,
    },
  }),
}));

const { recompileAgentSystemPrompt } = await import("../../agent/modify");

describe("recompileAgentSystemPrompt", () => {
  beforeEach(() => {
    conversationsRecompileMock.mockReset();
    conversationsRecompileMock.mockImplementation(() =>
      Promise.resolve("compiled-system-prompt"),
    );
  });

  test("calls the conversation recompile endpoint with mapped params", async () => {
    const compiledPrompt = await recompileAgentSystemPrompt(
      "conv-123",
      "agent-123",
    );

    expect(compiledPrompt).toBe("compiled-system-prompt");
    expect(conversationsRecompileMock).toHaveBeenCalledWith("conv-123", {
      agent_id: "agent-123",
    });
  });

  test("passes agent_id for default conversation recompiles", async () => {
    await recompileAgentSystemPrompt("default", "agent-123");

    expect(conversationsRecompileMock).toHaveBeenCalledWith("default", {
      agent_id: "agent-123",
    });
  });

  test("passes non-default conversation ids through unchanged", async () => {
    await recompileAgentSystemPrompt("['default']", "agent-123");

    expect(conversationsRecompileMock).toHaveBeenCalledWith("['default']", {
      agent_id: "agent-123",
    });
  });

  test("throws when conversation recompile has empty agent id", async () => {
    await expect(recompileAgentSystemPrompt("default", "")).rejects.toThrow(
      "recompileAgentSystemPrompt requires agentId",
    );
    expect(conversationsRecompileMock).not.toHaveBeenCalled();
  });
});
