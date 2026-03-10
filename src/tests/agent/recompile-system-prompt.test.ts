import { describe, expect, mock, test } from "bun:test";
import { recompileAgentSystemPrompt } from "../../agent/modify";

describe("recompileAgentSystemPrompt", () => {
  test("calls the Letta agent recompile endpoint with mapped params", async () => {
    const agentsRecompileMock = mock(
      (_agentId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      agents: {
        recompile: agentsRecompileMock,
      },
    };

    const compiledPrompt = await recompileAgentSystemPrompt(
      "agent-123",
      {
        updateTimestamp: true,
        dryRun: true,
      },
      client,
    );

    expect(compiledPrompt).toBe("compiled-system-prompt");
    expect(agentsRecompileMock).toHaveBeenCalledWith("agent-123", {
      dry_run: true,
      update_timestamp: true,
    });
  });
});
