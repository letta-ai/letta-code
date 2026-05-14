// Tests that ensureCorrectMemoryTool skips server-side tool management when the
// active backend does not support it (for example, local MemFS backends).

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { configureBackendMode } from "../../backend";
import { __testOverrideGetClient } from "../../backend/api/client";
import { ensureCorrectMemoryTool } from "../../tools/toolset";

// Track whether the client was ever used (it shouldn't be when server-side tool
// management is unavailable).
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

afterAll(() => {
  __testOverrideGetClient(null);
  configureBackendMode("api");
  mock.restore();
});

describe("ensureCorrectMemoryTool", () => {
  beforeEach(() => {
    configureBackendMode("api");
    __testOverrideGetClient(mockGetClient);
    retrieveMock.mockClear();
    updateMock.mockClear();
    mockGetClient.mockClear();
  });

  test("skips attaching memory tool when backend has no server-side tool management", async () => {
    configureBackendMode("local");

    await ensureCorrectMemoryTool("agent-123", "anthropic/claude-sonnet-4");

    // Should bail out before ever calling getClient.
    expect(mockGetClient).not.toHaveBeenCalled();
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("proceeds normally when server-side tool management is available", async () => {
    await ensureCorrectMemoryTool("agent-123", "anthropic/claude-sonnet-4");

    // Should have called getClient and retrieved the agent.
    expect(mockGetClient).toHaveBeenCalled();
    expect(retrieveMock).toHaveBeenCalled();
  });
});
