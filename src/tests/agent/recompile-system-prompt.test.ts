import { describe, expect, mock, test } from "bun:test";
import { recompileAgentSystemPrompt } from "../../agent/modify";

describe("recompileAgentSystemPrompt", () => {
  test("calls the conversation recompile endpoint with mapped params", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
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
    expect(conversationsRecompileMock).toHaveBeenCalledWith("conv-123", {
      dry_run: true,
    });
  });

  test("uses agent recompile endpoint for default conversation recompiles", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const agentsRecompileMock = mock(
      (_agentId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
      agents: {
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

    expect(agentsRecompileMock).toHaveBeenCalledWith("agent-123", {
      dry_run: undefined,
    });
    expect(conversationsRecompileMock).not.toHaveBeenCalled();
  });

  test("passes non-default conversation ids through unchanged", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const agentsRecompileMock = mock(
      (_agentId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
      agents: {
        recompile: agentsRecompileMock,
      },
    };

    await recompileAgentSystemPrompt("['default']", {}, client);

    expect(conversationsRecompileMock).toHaveBeenCalledWith("['default']", {
      dry_run: undefined,
    });
    expect(agentsRecompileMock).not.toHaveBeenCalled();
  });

  test("throws when default conversation recompile lacks agent id", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
      agents: {
        recompile: mock((_agentId: string, _params?: Record<string, unknown>) =>
          Promise.resolve("compiled-system-prompt"),
        ),
      },
    };

    await expect(
      recompileAgentSystemPrompt("default", {}, client),
    ).rejects.toThrow(
      'recompileAgentSystemPrompt requires options.agentId when conversationId is "default"',
    );
    expect(conversationsRecompileMock).not.toHaveBeenCalled();
  });

  test("falls back to conversation endpoint for default when agent endpoint is unavailable", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
    };

    await recompileAgentSystemPrompt(
      "default",
      {
        agentId: "agent-123",
      },
      client,
    );

    expect(conversationsRecompileMock).toHaveBeenCalledWith("default", {
      dry_run: undefined,
      agent_id: "agent-123",
    });
  });
});
