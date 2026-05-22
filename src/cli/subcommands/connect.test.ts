import { describe, expect, mock, test } from "bun:test";
import { runConnectSubcommand } from "@/cli/subcommands/connect";

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

describe("connect subcommand", () => {
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

    const exitCode = await runConnectSubcommand(["ollama"], deps);

    expect(exitCode).toBe(0);
    expect(deps.promptSecret).not.toHaveBeenCalled();
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "ollama",
      "not-needed",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "ollama",
      "lc-ollama",
      "not-needed",
    );
  });

  test("passes local provider base URL and timeout options", async () => {
    const { deps } = createIoDeps();

    const exitCode = await runConnectSubcommand(
      [
        "lmstudio",
        "--base-url",
        "http://127.0.0.1:1234/v1",
        "--timeout",
        "600s",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "lmstudio_openai",
      "not-needed",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "lmstudio_openai",
      "lc-lmstudio",
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

    const exitCode = await runConnectSubcommand(
      ["llama.cpp", "--base-url", "http://localhost:8080/v1"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "llama_cpp",
      "lc-llama-cpp",
      "not-needed",
      undefined,
      undefined,
      undefined,
      { baseURL: "http://localhost:8080/v1" },
    );
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
});
