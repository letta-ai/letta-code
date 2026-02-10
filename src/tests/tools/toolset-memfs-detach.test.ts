// Tests for detaching server-side memory tools when enabling memfs

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock getClient before importing the module under test

const detachMock = mock((_toolId: string, _opts: { agent_id: string }) =>
  Promise.resolve({}),
);
const retrieveMock = mock((_agentId: string, _opts?: Record<string, unknown>) =>
  Promise.resolve({
    tools: [
      { name: "memory", id: "tool-memory" },
      { name: "memory_apply_patch", id: "tool-memory-apply" },
      { name: "memory_insert", id: "tool-memory-insert" },
      { name: "memory_replace", id: "tool-memory-replace" },
      { name: "memory_rethink", id: "tool-memory-rethink" },
      { name: "web_search", id: "tool-web-search" },
      // No id should be ignored
      { name: "memory_replace" },
    ],
  }),
);

const mockGetClient = mock(() =>
  Promise.resolve({
    agents: {
      retrieve: retrieveMock,
      tools: {
        detach: detachMock,
      },
    },
  }),
);

mock.module("../../agent/client", () => ({
  getClient: mockGetClient,
}));

const { detachMemoryTools } = await import("../../tools/toolset");

describe("detachMemoryTools", () => {
  beforeEach(() => {
    detachMock.mockClear();
    retrieveMock.mockClear();
    mockGetClient.mockClear();
  });

  test("detaches all known memory tool variants", async () => {
    const detached = await detachMemoryTools("agent-123");
    expect(detached).toBe(true);

    const detachedToolIds = detachMock.mock.calls.map((call) => call[0]);
    expect(detachedToolIds).toEqual([
      "tool-memory",
      "tool-memory-apply",
      "tool-memory-insert",
      "tool-memory-replace",
      "tool-memory-rethink",
    ]);

    // Ensure we did not detach unrelated tools
    expect(detachedToolIds.includes("tool-web-search")).toBe(false);
  });

  test("returns false when no memory tools are attached", async () => {
    retrieveMock.mockResolvedValueOnce({
      tools: [{ name: "web_search", id: "tool-web-search" }],
    });

    const detached = await detachMemoryTools("agent-123");
    expect(detached).toBe(false);
    expect(detachMock).not.toHaveBeenCalled();
  });
});
