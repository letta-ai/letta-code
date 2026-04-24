// Tests that ensureCorrectMemoryTool skips re-attaching when memfs is enabled

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Track whether the client was ever used (it shouldn't be when memfs is on)
const retrieveMock = mock((_agentId: string, _opts?: Record<string, unknown>) =>
  Promise.resolve({
    tools: [{ name: "memory", id: "tool-memory" }],
    tool_rules: [],
  }),
);

const updateMock = mock((_agentId: string, _body: Record<string, unknown>) =>
  Promise.resolve({}),
);

const mockGetClient = mock(() =>
  Promise.resolve({
    agents: {
      retrieve: retrieveMock,
      update: updateMock,
      tools: { detach: mock(() => Promise.resolve({})) },
    },
    tools: { list: mock(() => Promise.resolve({ items: [] })) },
  }),
);

const isMemfsEnabledMock = mock((_agentId: string) => false);

mock.module("../../agent/client", () => ({
  getClient: mockGetClient,
}));

mock.module("../../agent/model", () => ({
  resolveModel: (_id: string) => "anthropic/claude-sonnet-4",
}));

mock.module("../../settings-manager", () => ({
  settingsManager: {
    isMemfsEnabled: isMemfsEnabledMock,
  },
}));

const { ensureCorrectMemoryTool } = await import("../../tools/toolset");

afterAll(() => {
  mock.restore();
});

describe("ensureCorrectMemoryTool", () => {
  beforeEach(() => {
    retrieveMock.mockClear();
    updateMock.mockClear();
    mockGetClient.mockClear();
    isMemfsEnabledMock.mockClear();
  });

  test("skips attaching memory tool when memfs is enabled", async () => {
    isMemfsEnabledMock.mockReturnValue(true);

    await ensureCorrectMemoryTool("agent-123", "anthropic/claude-sonnet-4");

    // Should bail out before ever calling getClient
    expect(mockGetClient).not.toHaveBeenCalled();
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("proceeds normally when memfs is disabled", async () => {
    isMemfsEnabledMock.mockReturnValue(false);

    await ensureCorrectMemoryTool("agent-123", "anthropic/claude-sonnet-4");

    // Should have called getClient and retrieved the agent
    expect(mockGetClient).toHaveBeenCalled();
    expect(retrieveMock).toHaveBeenCalled();
  });
});
