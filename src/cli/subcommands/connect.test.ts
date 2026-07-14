import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import { __testSetBackend, type Backend } from "@/backend";
import type { LocalOAuthConnectCallbacks } from "@/cli/commands/connect-local-oauth";
import { runConnectSubcommand } from "@/cli/subcommands/connect";

function setProviderTarget(target: "api" | "local") {
  __testSetBackend({
    capabilities: {
      remoteMemfs: target === "api",
      serverSideToolManagement: target === "api",
      serverSecrets: target === "api",
      agentFileImportExport: target === "api",
      promptRecompile: target === "api",
      byokProviderRefresh: target === "api",
      localModelCatalog: target === "local",
      localMemfs: target === "local",
    },
  } as Backend);
}

function createIoDeps() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    deps: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
      isTTY: () => true,
      ensureSettingsReady: mock(() => Promise.resolve()),
      promptSecret: mock(() => Promise.resolve("prompted-key")),
      checkProviderApiKey: mock(() => Promise.resolve()),
      createOrUpdateProvider: mock(() => Promise.resolve({ id: "provider-1" })),
      isChatGPTOAuthConnected: mock(() => Promise.resolve(false)),
      runChatGPTOAuthConnectFlow: mock(() =>
        Promise.resolve({ providerName: "chatgpt-plus-pro" }),
      ),
      providerStorageTargetLabel: () => "test storage",
    },
  };
}

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("connect subcommand", () => {
  beforeEach(() => {
    setProviderTarget("api");
  });

  afterEach(() => {
    setProviderTarget("api");
  });

  test("runs OAuth flow for codex alias", async () => {
    const { stdout, deps } = createIoDeps();

    const exitCode = await runConnectSubcommand(["codex"], deps);

    expect(exitCode).toBe(0);
    expect(deps.ensureSettingsReady).toHaveBeenCalledTimes(1);
    expect(deps.runChatGPTOAuthConnectFlow).toHaveBeenCalledTimes(1);
    expect(stdout.join("\n")).toContain(
      "Successfully connected to ChatGPT OAuth.",
    );
  });

  test("passes custom ChatGPT provider name to OAuth flow", async () => {
    const { stdout, deps } = createIoDeps();

    const exitCode = await runConnectSubcommand(
      ["chatgpt", "--name", "chatgpt-work"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.isChatGPTOAuthConnected).toHaveBeenCalledWith("chatgpt-work");
    expect(deps.runChatGPTOAuthConnectFlow).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: "chatgpt-work" }),
    );
    expect(stdout.join("\n")).toContain("Provider 'chatgpt-work' saved.");
  });

  test("connects API key provider from positional key", async () => {
    const { deps } = createIoDeps();

    const exitCode = await runConnectSubcommand(
      ["anthropic", "sk-ant-123"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "anthropic",
      "sk-ant-123",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "anthropic",
      "lc-anthropic",
      "sk-ant-123",
    );
  });

  test("initializes settings before validating API key provider", async () => {
    const { deps } = createIoDeps();
    const callOrder: string[] = [];
    deps.ensureSettingsReady = mock(() => {
      callOrder.push("settings");
      return Promise.resolve();
    });
    deps.checkProviderApiKey = mock(() => {
      callOrder.push("check");
      return Promise.resolve();
    });

    const exitCode = await runConnectSubcommand(
      ["anthropic", "sk-ant-123"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.ensureSettingsReady).toHaveBeenCalledTimes(1);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "anthropic",
      "sk-ant-123",
    );
    expect(callOrder).toEqual(["settings", "check"]);
  });

  test("connects API key provider in local target without initializing settings", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");

    const exitCode = await runConnectSubcommand(
      ["openai", "sk-local-123"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.ensureSettingsReady).not.toHaveBeenCalled();
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "openai",
      "sk-local-123",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "openai",
      "openai",
      "sk-local-123",
    );
  });

  test("returns error for missing key in non-TTY mode", async () => {
    const { stderr, deps } = createIoDeps();
    const nonTtyDeps = { ...deps, isTTY: () => false };

    const exitCode = await runConnectSubcommand(["openai"], nonTtyDeps);

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("Missing API key");
    expect(nonTtyDeps.promptSecret).not.toHaveBeenCalled();
  });

  test("prompts for missing key in TTY mode", async () => {
    const { deps } = createIoDeps();

    const exitCode = await runConnectSubcommand(["gemini"], deps);

    expect(exitCode).toBe(0);
    expect(deps.promptSecret).toHaveBeenCalledTimes(1);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "google_ai",
      "prompted-key",
    );
  });

  test("connects API-key optional local providers without prompting", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");

    const exitCode = await withEnv({ OLLAMA_LOCAL_API_KEY: undefined }, () =>
      runConnectSubcommand(["ollama"], deps),
    );

    expect(exitCode).toBe(0);
    expect(deps.ensureSettingsReady).not.toHaveBeenCalled();
    expect(deps.promptSecret).not.toHaveBeenCalled();
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "ollama",
      "not-needed",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "ollama",
      "ollama",
      "not-needed",
    );
  });

  test("passes local provider base URL and timeout options", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");

    const exitCode = await withEnv({ LMSTUDIO_API_KEY: undefined }, () =>
      runConnectSubcommand(
        [
          "lmstudio",
          "--base-url",
          "http://127.0.0.1:1234/v1",
          "--timeout",
          "600s",
        ],
        deps,
      ),
    );

    expect(exitCode).toBe(0);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "lmstudio_openai",
      "not-needed",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "lmstudio_openai",
      "lmstudio",
      "not-needed",
      undefined,
      undefined,
      undefined,
      {
        baseURL: "http://127.0.0.1:1234/v1",
        timeout: 600_000,
      },
    );
  });

  test("connects llama.cpp local provider alias", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");

    const exitCode = await withEnv({ LLAMA_CPP_API_KEY: undefined }, () =>
      runConnectSubcommand(
        ["llama.cpp", "--base-url", "http://localhost:8080/v1"],
        deps,
      ),
    );

    expect(exitCode).toBe(0);
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "llama_cpp",
      "llama-cpp",
      "not-needed",
      undefined,
      undefined,
      undefined,
      { baseURL: "http://localhost:8080/v1" },
    );
  });

  test("uses LM Studio environment API key when no key is provided", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");

    const exitCode = await withEnv({ LMSTUDIO_API_KEY: "1234" }, () =>
      runConnectSubcommand(
        ["lmstudio", "--base-url", "http://localhost:8000/v1"],
        deps,
      ),
    );

    expect(exitCode).toBe(0);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "lmstudio_openai",
      "1234",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "lmstudio_openai",
      "lmstudio",
      "1234",
      undefined,
      undefined,
      undefined,
      { baseURL: "http://localhost:8000/v1" },
    );
  });

  const CODEX_LOGIN_SELECT_PROMPT: OAuthSelectPrompt = {
    message: "Select OpenAI Codex login method:",
    options: [
      { id: "browser", label: "Browser login (default)" },
      { id: "device_code", label: "Device code login (headless)" },
    ],
  };

  function createLocalOAuthFlowMock() {
    const selections: (string | undefined)[] = [];
    const runLocalOAuthConnectFlow = mock(
      async (_provider: unknown, callbacks: LocalOAuthConnectCallbacks) => {
        selections.push(await callbacks.onSelect?.(CODEX_LOGIN_SELECT_PROMPT));
        return { providerName: "chatgpt-plus-pro" };
      },
    );
    return { selections, runLocalOAuthConnectFlow };
  }

  test("guides users to local backend for xAI Grok OAuth on API target", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("api");

    const exitCode = await runConnectSubcommand(["xai-oauth"], deps);

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("local backend");
    expect(stderr.join("\n")).toContain("xai-oauth");
  });

  test("local codex connect defaults to the first login method option", async () => {
    const { stdout, deps } = createIoDeps();
    setProviderTarget("local");
    const { selections, runLocalOAuthConnectFlow } = createLocalOAuthFlowMock();

    const exitCode = await runConnectSubcommand(["codex"], {
      ...deps,
      runLocalOAuthConnectFlow,
    });

    expect(exitCode).toBe(0);
    expect(runLocalOAuthConnectFlow).toHaveBeenCalledTimes(1);
    expect(selections).toEqual(["browser"]);
    expect(stdout.join("\n")).toContain("Successfully connected");
  });

  test("local codex connect honors --method device-code", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");
    const { selections, runLocalOAuthConnectFlow } = createLocalOAuthFlowMock();

    const exitCode = await runConnectSubcommand(
      ["codex", "--method", "device-code"],
      { ...deps, runLocalOAuthConnectFlow },
    );

    expect(exitCode).toBe(0);
    expect(selections).toEqual(["device_code"]);
  });

  test("local codex connect rejects unknown --method values", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("local");
    const { runLocalOAuthConnectFlow } = createLocalOAuthFlowMock();

    const exitCode = await runConnectSubcommand(
      ["codex", "--method", "carrier-pigeon"],
      { ...deps, runLocalOAuthConnectFlow },
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain(
      "Unknown ChatGPT Plus/Pro (Codex Subscription) login method: carrier-pigeon",
    );
    expect(stderr.join("\n")).toContain("Available: browser, device_code");
  });

  test("validates bedrock iam required flags", async () => {
    const { stderr, deps } = createIoDeps();

    const exitCode = await runConnectSubcommand(
      ["bedrock", "--method", "iam", "--access-key", "AKIA123"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("Missing IAM fields");
  });

  test("initializes settings before validating bedrock credentials", async () => {
    const { deps } = createIoDeps();
    const callOrder: string[] = [];
    deps.ensureSettingsReady = mock(() => {
      callOrder.push("settings");
      return Promise.resolve();
    });
    deps.checkProviderApiKey = mock(() => {
      callOrder.push("check");
      return Promise.resolve();
    });

    const exitCode = await runConnectSubcommand(
      [
        "bedrock",
        "--method",
        "iam",
        "--access-key",
        "AKIA123",
        "--secret-key",
        "secret123",
        "--region",
        "us-east-1",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.ensureSettingsReady).toHaveBeenCalledTimes(1);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "bedrock",
      "secret123",
      "AKIA123",
      "us-east-1",
      undefined,
    );
    expect(callOrder).toEqual(["settings", "check"]);
  });
});
