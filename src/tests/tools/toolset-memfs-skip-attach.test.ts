// Tests that ensureCorrectMemoryTool skips re-attaching server-side memory
// tools when filesystem-backed memory (memfs) is enabled for the agent.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Backend } from "../../backend";
import { __testSetBackend } from "../../backend";
import { settingsManager } from "../../settings-manager";

const retrieveMock = mock((_agentId: string, _opts?: Record<string, unknown>) =>
  Promise.resolve({
    tools: [{ name: "memory", id: "tool-memory" }],
    tool_rules: [],
  }),
);

const updateMock = mock((_agentId: string, _body: Record<string, unknown>) =>
  Promise.resolve({}),
);

const mockBackend = {
  capabilities: {
    remoteMemfs: true,
    serverSideToolManagement: true,
    serverSecrets: true,
    agentFileImportExport: true,
    promptRecompile: true,
    byokProviderRefresh: true,
    localModelCatalog: false,
    localMemfs: false,
  },
  retrieveAgent: retrieveMock,
  updateAgent: updateMock,
} as unknown as Backend;

const originalIsMemfsEnabled =
  settingsManager.isMemfsEnabled.bind(settingsManager);

const { ensureCorrectMemoryTool } = await import("../../tools/toolset");

describe("ensureCorrectMemoryTool", () => {
  beforeEach(() => {
    retrieveMock.mockClear();
    updateMock.mockClear();
    __testSetBackend(mockBackend);
  });

  afterEach(() => {
    (
      settingsManager as unknown as {
        isMemfsEnabled: (agentId: string) => boolean;
      }
    ).isMemfsEnabled = originalIsMemfsEnabled;
    __testSetBackend(null);
  });

  test("skips attaching memory tool when memfs is enabled", async () => {
    (
      settingsManager as unknown as {
        isMemfsEnabled: (agentId: string) => boolean;
      }
    ).isMemfsEnabled = () => true;

    await ensureCorrectMemoryTool("agent-123", "anthropic/claude-sonnet-4");

    expect(retrieveMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("proceeds normally when memfs is disabled", async () => {
    (
      settingsManager as unknown as {
        isMemfsEnabled: (agentId: string) => boolean;
      }
    ).isMemfsEnabled = () => false;

    await ensureCorrectMemoryTool("agent-123", "anthropic/claude-sonnet-4");

    expect(retrieveMock).toHaveBeenCalled();
  });
});
