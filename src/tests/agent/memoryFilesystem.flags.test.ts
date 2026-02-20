import { beforeEach, describe, expect, mock, test } from "bun:test";

const GIT_MEMORY_ENABLED_TAG = "git-memory-enabled";

let serverUrl = "https://api.letta.com";
let gitRepoExists = false;
const memfsState = new Map<string, boolean>();

const mockGetServerUrl = mock(() => serverUrl);
const isMemfsEnabledMock = mock(
  (agentId: string) => memfsState.get(agentId) === true,
);
const setMemfsEnabledMock = mock((agentId: string, enabled: boolean) => {
  memfsState.set(agentId, enabled);
});

const updateAgentSystemPromptMemfsMock = mock(
  (_agentId: string, _enabled: boolean) => Promise.resolve({ success: true }),
);
const detachMemoryToolsMock = mock((_agentId: string) => Promise.resolve(true));
const addGitMemoryTagMock = mock((_agentId: string) => Promise.resolve());
const removeGitMemoryTagMock = mock((_agentId: string) => Promise.resolve());
const isGitRepoMock = mock((_agentId: string) => gitRepoExists);
const cloneMemoryRepoMock = mock((_agentId: string) => Promise.resolve());
const pullMemoryMock = mock((_agentId: string) =>
  Promise.resolve({ summary: "Already up to date." }),
);

mock.module("../../agent/client", () => ({
  getServerUrl: mockGetServerUrl,
}));

mock.module("../../settings-manager", () => ({
  settingsManager: {
    isMemfsEnabled: isMemfsEnabledMock,
    setMemfsEnabled: setMemfsEnabledMock,
  },
}));

mock.module("../../agent/modify", () => ({
  updateAgentSystemPromptMemfs: updateAgentSystemPromptMemfsMock,
}));

mock.module("../../tools/toolset", () => ({
  detachMemoryTools: detachMemoryToolsMock,
}));

mock.module("../../agent/memoryGit", () => ({
  GIT_MEMORY_ENABLED_TAG,
  addGitMemoryTag: addGitMemoryTagMock,
  removeGitMemoryTag: removeGitMemoryTagMock,
  isGitRepo: isGitRepoMock,
  cloneMemoryRepo: cloneMemoryRepoMock,
  pullMemory: pullMemoryMock,
}));

const { applyMemfsFlags } = await import("../../agent/memoryFilesystem");

describe("applyMemfsFlags", () => {
  const agentId = "agent-123";

  beforeEach(() => {
    serverUrl = "https://api.letta.com";
    gitRepoExists = false;
    memfsState.clear();

    mockGetServerUrl.mockClear();
    isMemfsEnabledMock.mockClear();
    setMemfsEnabledMock.mockClear();
    updateAgentSystemPromptMemfsMock.mockClear();
    detachMemoryToolsMock.mockClear();
    addGitMemoryTagMock.mockClear();
    removeGitMemoryTagMock.mockClear();
    isGitRepoMock.mockClear();
    cloneMemoryRepoMock.mockClear();
    pullMemoryMock.mockClear();
  });

  test("auto-enables from server tag when local memfs setting is missing", async () => {
    memfsState.set(agentId, false);

    const result = await applyMemfsFlags(agentId, undefined, undefined, {
      agentTags: [GIT_MEMORY_ENABLED_TAG],
    });

    expect(result.action).toBe("enabled");
    expect(setMemfsEnabledMock).toHaveBeenCalledWith(agentId, true);
    expect(updateAgentSystemPromptMemfsMock).toHaveBeenCalledWith(
      agentId,
      true,
    );
    expect(detachMemoryToolsMock).toHaveBeenCalledWith(agentId);
    expect(addGitMemoryTagMock).toHaveBeenCalledWith(agentId);
    expect(cloneMemoryRepoMock).toHaveBeenCalledWith(agentId);
  });

  test("does not auto-enable without explicit flag when local setting is off and tag is absent", async () => {
    memfsState.set(agentId, false);

    const result = await applyMemfsFlags(agentId, undefined, undefined, {
      agentTags: [],
    });

    expect(result.action).toBe("unchanged");
    expect(updateAgentSystemPromptMemfsMock).not.toHaveBeenCalled();
    expect(setMemfsEnabledMock).not.toHaveBeenCalled();
    expect(detachMemoryToolsMock).not.toHaveBeenCalled();
    expect(addGitMemoryTagMock).not.toHaveBeenCalled();
    expect(cloneMemoryRepoMock).not.toHaveBeenCalled();
  });

  test("explicit disable clears local memfs and removes server-side tag", async () => {
    memfsState.set(agentId, true);

    const result = await applyMemfsFlags(agentId, undefined, true, {
      agentTags: [GIT_MEMORY_ENABLED_TAG],
    });

    expect(result.action).toBe("disabled");
    expect(updateAgentSystemPromptMemfsMock).toHaveBeenCalledWith(
      agentId,
      false,
    );
    expect(setMemfsEnabledMock).toHaveBeenCalledWith(agentId, false);
    expect(removeGitMemoryTagMock).toHaveBeenCalledWith(agentId);
    expect(addGitMemoryTagMock).not.toHaveBeenCalled();
    expect(detachMemoryToolsMock).not.toHaveBeenCalled();
  });
});
