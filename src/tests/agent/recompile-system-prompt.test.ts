import { beforeEach, describe, expect, mock, test } from "bun:test";

const agentsRecompileMock = mock(
  (_agentId: string, _params?: Record<string, unknown>) =>
    Promise.resolve("compiled-system-prompt"),
);
const mockGetClient = mock(() =>
  Promise.resolve({
    agents: {
      recompile: agentsRecompileMock,
    },
  }),
);

mock.module("../../agent/client", () => ({
  getClient: mockGetClient,
}));

const { recompileAgentSystemPrompt } = await import("../../agent/modify");

describe("recompileAgentSystemPrompt", () => {
  beforeEach(() => {
    agentsRecompileMock.mockClear();
    mockGetClient.mockClear();
  });

  test("calls the Letta agent recompile endpoint with mapped params", async () => {
    const compiledPrompt = await recompileAgentSystemPrompt("agent-123", {
      updateTimestamp: true,
      dryRun: true,
    });

    expect(compiledPrompt).toBe("compiled-system-prompt");
    expect(mockGetClient).toHaveBeenCalledTimes(1);
    expect(agentsRecompileMock).toHaveBeenCalledWith("agent-123", {
      dry_run: true,
      update_timestamp: true,
    });
  });
});
