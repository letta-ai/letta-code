import { describe, expect, mock, test } from "bun:test";
import { runConnectSubcommand } from "../../cli/subcommands/connect";

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
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "anthropic",
      "lc-anthropic",
      "sk-ant-123",
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  test("connects zAI coding plan with dedicated base URL", async () => {
    const { deps } = createIoDeps();

    const exitCode = await runConnectSubcommand(["zai-coding", "zk-123"], deps);

    expect(exitCode).toBe(0);
    expect(deps.checkProviderApiKey).toHaveBeenCalledWith(
      "zai_coding",
      "zk-123",
      undefined,
      undefined,
      undefined,
      "https://api.z.ai/api/coding/paas/v4",
    );
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "zai_coding",
      "lc-zai-coding",
      "zk-123",
      undefined,
      undefined,
      undefined,
      "https://api.z.ai/api/coding/paas/v4",
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
      undefined,
      undefined,
      undefined,
      undefined,
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
