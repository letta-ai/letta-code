import { describe, expect, mock, test } from "bun:test";
import { recompileAgentSystemPrompt } from "../../agent/modify";

describe("recompileAgentSystemPrompt", () => {
  test("calls the conversation recompile endpoint with mapped params", async () => {
    const agentsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: agentsRecompileMock,
      },
    };

    const compiledPrompt = await recompileAgentSystemPrompt(
      "conv-123",
      {
        dryRun: true,
      },
      client,
    );

    expect(compiledPrompt).toBe("compiled-system-prompt");
    expect(agentsRecompileMock).toHaveBeenCalledWith("conv-123", {
      dry_run: true,
    });
  });

  test("passes agent_id for default conversation recompiles", async () => {
    const agentsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: agentsRecompileMock,
      },
    };

    await recompileAgentSystemPrompt(
      "default",
      {
        agentId: "agent-123",
      },
      client,
    );

    expect(agentsRecompileMock).toHaveBeenCalledWith("default", {
      dry_run: undefined,
      agent_id: "agent-123",
    });
  });

  test("throws when default conversation recompile lacks agent id", async () => {
    const agentsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: agentsRecompileMock,
      },
    };

    await expect(
      recompileAgentSystemPrompt("default", {}, client),
    ).rejects.toThrow(
      'recompileAgentSystemPrompt requires options.agentId when conversationId is "default"',
    );
    expect(agentsRecompileMock).not.toHaveBeenCalled();
  });
});
