import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const retrieveMock = mock((_agentId: string, _opts?: Record<string, unknown>) =>
  Promise.resolve({
    tags: ["origin:letta-code"],
    tool_rules: [
      { type: "requires_approval", tool_name: "Bash" },
      { type: "requires_approval", tool_name: "Task" },
      { type: "requires_approval", tool_name: "web_search" },
      { type: "continue", tool_name: "fetch_webpage" },
    ],
  }),
);
const updateMock = mock((_agentId: string, _payload: Record<string, unknown>) =>
  Promise.resolve({}),
);
const mockGetClient = mock(() =>
  Promise.resolve({
    agents: {
      retrieve: retrieveMock,
      update: updateMock,
    },
  }),
);

mock.module("../../agent/client", () => ({
  getClient: mockGetClient,
  getServerUrl: () => "http://localhost:8283",
}));

const { clearPersistedClientToolRules, shouldClearPersistedToolRules } =
  await import("../../tools/toolset");

describe("client tool rule cleanup", () => {
  beforeEach(() => {
    retrieveMock.mockClear();
    updateMock.mockClear();
    mockGetClient.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  test("marks Letta Code agents with any persisted tool rules for cleanup", () => {
    expect(
      shouldClearPersistedToolRules({
        tags: ["origin:letta-code"],
        tool_rules: [{ type: "requires_approval", tool_name: "Bash" }],
      }),
    ).toBe(true);
  });

  test("clears all tool rules for Letta Code agents on startup", async () => {
    const result = await clearPersistedClientToolRules("agent-123");

    expect(result).toEqual({
      removedToolNames: ["Bash", "Task", "web_search", "fetch_webpage"],
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]?.[1]).toEqual({
      tool_rules: [],
    });
  });

  test("skips update when there are no persisted tool rules", async () => {
    retrieveMock.mockResolvedValueOnce({
      tags: ["origin:letta-code"],
      tool_rules: [],
    });

    const result = await clearPersistedClientToolRules("agent-123");

    expect(result).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("skips update for non-Letta Code agents", async () => {
    retrieveMock.mockResolvedValueOnce({
      tags: ["some-other-tag"],
      tool_rules: [{ type: "requires_approval", tool_name: "web_search" }],
    });

    const result = await clearPersistedClientToolRules("agent-123");

    expect(result).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
