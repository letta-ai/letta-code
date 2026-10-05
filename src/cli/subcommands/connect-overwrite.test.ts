import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { __testSetBackend, type Backend, getBackend } from "@/backend";
import type { ProviderResponse } from "@/backend/api/providers";
import { runConnectSubcommand } from "@/cli/subcommands/connect";
import type { ProviderOperationOptions } from "@/providers/byok-providers";

function setProviderTarget(target: "api" | "local") {
  __testSetBackend({
    capabilities: {
      remoteMemfs: target === "api",
      serverSideToolManagement: target === "api",
      serverSecrets: target === "api",
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
      getProviderByNameStrict: mock<
        (
          providerName: string,
          options?: ProviderOperationOptions,
        ) => Promise<ProviderResponse | null>
      >(() => Promise.resolve(null)),
      confirmOverwrite: mock(() => Promise.resolve(false)),
      isChatGPTOAuthConnected: mock(() => Promise.resolve(false)),
      runChatGPTOAuthConnectFlow: mock(() =>
        Promise.resolve({ providerName: "chatgpt-plus-pro" }),
      ),
      runCloudOAuthConnectFlow: mock(() =>
        Promise.resolve({ providerName: "openrouter-oauth" }),
      ),
      runCloudXaiOAuthConnectFlow: mock(() =>
        Promise.resolve({ providerName: "lc-xai" }),
      ),
      providerStorageTargetLabel: () => "test storage",
    },
  };
}

// Regression for LET-13157: `letta connect openai-compatible` writes a
// single BYOK provider slot keyed by provider name, and a second run
// silently replaced the endpoint (and billing account) stored there.
// Reconnecting must not swap an existing slot's endpoint without explicit
// confirmation, and `--name` must be honored so a second endpoint can be
// saved alongside the first.
describe("connect subcommand overwrite guard", () => {
  let previousBackend: Backend;

  beforeEach(() => {
    previousBackend = getBackend();
    setProviderTarget("api");
  });

  afterEach(() => {
    __testSetBackend(previousBackend);
  });

  const EXISTING_OPENAI_COMPATIBLE_PROVIDER = {
    id: "provider-mimo",
    name: "openai-compatible",
    provider_type: "openai-compatible",
    base_url: "https://mimo.example/v1",
  };
  const EXISTING_API_PROVIDER: ProviderResponse = {
    id: "provider-existing",
    name: "openai-compatible",
    provider_type: "openai",
    base_url: "https://mimo.example/v1",
  };

  test("blocks a reconnect that would swap the openai-compatible endpoint", async () => {
    const { stdout, stderr, deps } = createIoDeps();
    setProviderTarget("local");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve(EXISTING_OPENAI_COMPATIBLE_PROVIDER),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(false));

    const exitCode = await runConnectSubcommand(
      ["openai-compatible", "--base-url", "https://opencode.example/v1"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.getProviderByNameStrict).toHaveBeenCalledWith(
      "openai-compatible",
      {
        target: "local",
      },
    );
    expect(deps.checkProviderApiKey).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).not.toHaveBeenCalled();
    const output = [...stdout, ...stderr].join("\n");
    expect(output).toContain("https://mimo.example/v1");
    expect(output).toContain("https://opencode.example/v1");
    expect(output).toContain("--force");
  });

  test("aborts a non-interactive overwrite without --force", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("local");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve(EXISTING_OPENAI_COMPATIBLE_PROVIDER),
    );
    const nonTtyDeps = { ...deps, isTTY: () => false };

    const exitCode = await runConnectSubcommand(
      ["openai-compatible", "--base-url", "https://opencode.example/v1"],
      nonTtyDeps,
    );

    expect(exitCode).toBe(1);
    expect(nonTtyDeps.createOrUpdateProvider).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("--force");
  });

  test("overwrites the slot after explicit confirmation", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve(EXISTING_OPENAI_COMPATIBLE_PROVIDER),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(true));

    const exitCode = await runConnectSubcommand(
      ["openai-compatible", "--base-url", "https://opencode.example/v1"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "openai-compatible",
      "openai-compatible",
      "not-needed",
      undefined,
      undefined,
      undefined,
      { baseURL: "https://opencode.example/v1" },
    );
  });

  test("overwrites the slot with --force without prompting", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve(EXISTING_OPENAI_COMPATIBLE_PROVIDER),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(false));

    const exitCode = await runConnectSubcommand(
      [
        "openai-compatible",
        "--base-url",
        "https://opencode.example/v1",
        "--force",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "openai-compatible",
      "openai-compatible",
      "not-needed",
      undefined,
      undefined,
      undefined,
      { baseURL: "https://opencode.example/v1" },
    );
  });

  test("saves a second openai-compatible endpoint under --name", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("api");

    const exitCode = await runConnectSubcommand(
      [
        "openai-compatible",
        "--name",
        "opencode-go",
        "--base-url",
        "https://opencode.example/v1",
        "--api-key",
        "opencode-key",
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.ensureSettingsReady).toHaveBeenCalledTimes(1);
    expect(deps.getProviderByNameStrict).toHaveBeenCalledWith("opencode-go", {
      target: "api",
    });
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "openai",
      "opencode-go",
      "opencode-key",
      undefined,
      undefined,
      undefined,
      { baseURL: "https://opencode.example/v1" },
    );
  });

  test("rejects --name for local storage until the runtime wires custom names", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("local");

    const exitCode = await runConnectSubcommand(
      [
        "openai-compatible",
        "--name",
        "opencode-go",
        "--base-url",
        "https://opencode.example/v1",
      ],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain(
      "not supported for local provider storage",
    );
    expect(deps.getProviderByNameStrict).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).not.toHaveBeenCalled();
  });

  test("guards a --name that already belongs to a different slot", async () => {
    const { stdout, stderr, deps } = createIoDeps();
    setProviderTarget("api");
    deps.getProviderByNameStrict = mock((providerName: string) =>
      providerName === "opencode-go"
        ? Promise.resolve({
            id: "provider-occupied",
            name: "opencode-go",
            provider_type: "ollama",
            base_url: "http://localhost:11434/v1",
          })
        : Promise.resolve(null),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(false));

    const exitCode = await runConnectSubcommand(
      [
        "openai-compatible",
        "--name",
        "opencode-go",
        "--base-url",
        "https://opencode.example/v1",
        "--api-key",
        "opencode-key",
      ],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).not.toHaveBeenCalled();
    const output = [...stdout, ...stderr].join("\n");
    expect(output).toContain("http://localhost:11434/v1");
    expect(output).toContain("ollama");
  });

  test("rejects a provider-type collision even with --force", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("api");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve({
        id: "provider-occupied",
        name: "openai-compatible",
        provider_type: "anthropic",
      }),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(true));

    const exitCode = await runConnectSubcommand(
      [
        "openai-compatible",
        "--base-url",
        "https://opencode.example/v1",
        "--api-key",
        "key",
        "--force",
      ],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("cannot change a provider's type");
  });

  test("rejects a local provider-type collision without suggesting --name", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("local");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve({
        id: "provider-occupied",
        name: "openai-compatible",
        provider_type: "ollama",
        base_url: "http://localhost:11434/v1",
      }),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(true));

    const exitCode = await runConnectSubcommand(
      ["openai-compatible", "--base-url", "https://opencode.example/v1"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).not.toHaveBeenCalled();
    const output = stderr.join("\n");
    expect(output).toContain("cannot change a provider's type");
    expect(output).not.toContain("--name");
  });

  test("aborts when the existing-slot lookup fails instead of bypassing the guard", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("api");
    deps.getProviderByNameStrict = mock(() =>
      Promise.reject(new Error("request failed")),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(true));

    const exitCode = await runConnectSubcommand(
      [
        "openai-compatible",
        "--base-url",
        "https://opencode.example/v1",
        "--api-key",
        "third-party-key",
      ],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain(
      "Could not check for an existing provider",
    );
  });

  test("keeps same-endpoint reconnects prompt-free for key rotation", async () => {
    const { deps } = createIoDeps();
    setProviderTarget("local");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve(EXISTING_OPENAI_COMPATIBLE_PROVIDER),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(false));

    const exitCode = await runConnectSubcommand(
      ["openai-compatible", "--base-url", "https://mimo.example/v1"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.createOrUpdateProvider).toHaveBeenCalledWith(
      "openai-compatible",
      "openai-compatible",
      "not-needed",
      undefined,
      undefined,
      undefined,
      { baseURL: "https://mimo.example/v1" },
    );
  });

  test("local overwrite abort does not suggest --name", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("local");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve(EXISTING_OPENAI_COMPATIBLE_PROVIDER),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(false));

    const exitCode = await runConnectSubcommand(
      ["openai-compatible", "--base-url", "https://opencode.example/v1"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("Re-run with --force to overwrite it.");
    expect(stderr.join("\n")).not.toContain("--name");
  });

  test("api overwrite abort suggests --name to save under a different slot", async () => {
    const { stderr, deps } = createIoDeps();
    setProviderTarget("api");
    deps.getProviderByNameStrict = mock(() =>
      Promise.resolve(EXISTING_API_PROVIDER),
    );
    deps.confirmOverwrite = mock(() => Promise.resolve(false));

    const exitCode = await runConnectSubcommand(
      [
        "openai-compatible",
        "--base-url",
        "https://opencode.example/v1",
        "--api-key",
        "key",
      ],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain(
      "Re-run with --force to overwrite it, or pass --name to save this connection under a different provider name.",
    );
  });

  test("local help omits --name examples that are not supported in local storage", async () => {
    const { stdout, deps } = createIoDeps();
    setProviderTarget("local");

    const exitCode = await runConnectSubcommand(["help"], deps);

    expect(exitCode).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("letta connect openai-compatible --base-url");
    expect(output).not.toContain("--name");
  });

  test("api help includes --name examples for custom provider slots", async () => {
    const { stdout, deps } = createIoDeps();
    setProviderTarget("api");

    const exitCode = await runConnectSubcommand(["help"], deps);

    expect(exitCode).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain(
      "letta connect openai-compatible --name my-endpoint --base-url",
    );
    expect(output).toContain("letta connect chatgpt --name chatgpt-work");
  });
});
