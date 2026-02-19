import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const createMock = mock((_params: Record<string, unknown>) =>
  Promise.resolve({ id: "agent-created" }),
);
const retrieveMock = mock((_agentId: string, _opts?: Record<string, unknown>) =>
  Promise.resolve({ id: "agent-created" }),
);

const getClientMock = mock(() =>
  Promise.resolve({
    agents: {
      create: createMock,
      retrieve: retrieveMock,
    },
  }),
);

const getServerUrlMock = mock(() => "https://api.example.test");
mock.module("../../agent/client", () => ({
  getClient: getClientMock,
  getServerUrl: getServerUrlMock,
}));

const getSettingsWithSecureTokensMock = mock(() =>
  Promise.resolve({ env: { LETTA_API_KEY: "sk-test" } }),
);
mock.module("../../settings-manager", () => ({
  settingsManager: {
    getSettingsWithSecureTokens: getSettingsWithSecureTokensMock,
  },
}));

const getLettaCodeHeadersMock = mock((_apiKey?: string) => ({
  Authorization: "Bearer sk-test",
  "Content-Type": "application/json",
  "User-Agent": "letta-code/test",
  "X-Letta-Source": "letta-code",
}));
mock.module("../../agent/http-headers", () => ({
  getLettaCodeHeaders: getLettaCodeHeadersMock,
}));

mock.module("../../agent/model", () => ({
  formatAvailableModels: () => "test-model",
  getDefaultModel: () => "anthropic/claude-sonnet-4",
  getModelUpdateArgs: () => undefined,
  resolveModel: (id: string) => id,
}));

mock.module("../../agent/available-models", () => ({
  getModelContextWindow: () => Promise.resolve(undefined),
}));

mock.module("../../agent/memory", () => ({
  getDefaultMemoryBlocks: () => Promise.resolve([]),
}));

mock.module("../../agent/memoryPrompt", () => ({
  reconcileMemoryPrompt: (prompt: string) => prompt,
}));

mock.module("../../agent/modify", () => ({
  updateAgentLLMConfig: () => Promise.resolve(),
}));

mock.module("../../agent/promptAssets", () => ({
  resolveSystemPrompt: () => Promise.resolve("system prompt"),
}));

mock.module("../../tools/manager", () => ({
  isOpenAIModel: () => false,
}));

const { createAgent } = await import("../../agent/create");

function missingBaseToolsError(): Error & { status: number } {
  return Object.assign(
    new Error(
      `400 {"detail":"Tools not found by name: {'fetch_webpage', 'memory'}"}`,
    ),
    { status: 400 },
  );
}

describe("createAgent base-tools recovery", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    ) as unknown as typeof fetch;

    createMock.mockClear();
    retrieveMock.mockClear();
    getClientMock.mockClear();
    getServerUrlMock.mockClear();
    getSettingsWithSecureTokensMock.mockClear();
    getLettaCodeHeadersMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("bootstraps base tools then retries agent creation with original tools", async () => {
    createMock
      .mockRejectedValueOnce(missingBaseToolsError())
      .mockResolvedValueOnce({ id: "agent-retry-success" });
    retrieveMock.mockResolvedValueOnce({ id: "agent-retry-success" });

    const result = await createAgent({ name: "Retry Agent" });

    expect(result.agent.id).toBe("agent-retry-success");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[0]?.tools).toEqual([
      "memory",
      "web_search",
      "fetch_webpage",
    ]);
    expect(createMock.mock.calls[1]?.[0]?.tools).toEqual([
      "memory",
      "web_search",
      "fetch_webpage",
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.test/v1/tools/add-base-tools",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("falls back to creating agent with no server-side tools after second failure", async () => {
    createMock
      .mockRejectedValueOnce(missingBaseToolsError())
      .mockRejectedValueOnce(new Error("still failing after bootstrap"))
      .mockResolvedValueOnce({ id: "agent-no-tools" });
    retrieveMock.mockResolvedValueOnce({ id: "agent-no-tools" });

    const result = await createAgent({ name: "No Tools Agent" });

    expect(result.agent.id).toBe("agent-no-tools");
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock.mock.calls[0]?.[0]?.tools).toEqual([
      "memory",
      "web_search",
      "fetch_webpage",
    ]);
    expect(createMock.mock.calls[1]?.[0]?.tools).toEqual([
      "memory",
      "web_search",
      "fetch_webpage",
    ]);
    expect(createMock.mock.calls[2]?.[0]?.tools).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("does not trigger bootstrap for unrelated missing tools", async () => {
    createMock.mockRejectedValueOnce(
      Object.assign(
        new Error(`400 {"detail":"Tools not found by name: {'custom_tool'}"}`),
        { status: 400 },
      ),
    );

    await expect(createAgent({ name: "Custom Tool Agent" })).rejects.toThrow(
      "custom_tool",
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
