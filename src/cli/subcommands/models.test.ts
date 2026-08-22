import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { runModelsSubcommand } from "@/cli/subcommands/models";

type ListedModel = Awaited<ReturnType<Backend["listModels"]>>[number];

function makeModel(overrides: Partial<ListedModel> = {}): ListedModel {
  return {
    context_window: 200000,
    max_context_window: 200000,
    model: "claude-sonnet-4-5",
    model_endpoint_type: "anthropic",
    name: "claude-sonnet-4-5",
    provider_type: "anthropic",
    handle: "anthropic/claude-sonnet-4-5",
    display_name: "Claude Sonnet 4.5",
    provider_name: "anthropic",
    ...overrides,
  } as ListedModel;
}

function makeRuntimeModel(model: Record<string, unknown>): ListedModel {
  return model as unknown as ListedModel;
}

function makeBackend(input: {
  models?: ListedModel[];
  onListModels?: (options: unknown) => void;
  byokProviderRefresh?: boolean;
}): Backend {
  return {
    capabilities: {
      remoteMemfs: true,
      serverSideToolManagement: true,
      serverSecrets: true,
      agentFileImportExport: true,
      promptRecompile: true,
      byokProviderRefresh: input.byokProviderRefresh ?? true,
      localModelCatalog: false,
      localMemfs: false,
    },
    listModels: async (options: unknown) => {
      input.onListModels?.(options);
      return input.models ?? [makeModel()];
    },
  } as unknown as Backend;
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
      initializeSettings: async () => {},
    },
  };
}

describe("models subcommand", () => {
  test("lists models as JSON by default", async () => {
    const output = captureOutput();
    let listedWith: unknown = "not-called";

    const exitCode = await runModelsSubcommand([], {
      ...output.deps,
      getBackend: () =>
        makeBackend({
          models: [makeModel()],
          onListModels: (options) => {
            listedWith = options;
          },
        }),
    });

    expect(exitCode).toBe(0);
    expect(listedWith).toBeUndefined();
    expect(output.stderr).toEqual([]);
    const parsed = JSON.parse(output.stdout.join("\n"));
    expect(parsed).toEqual([
      expect.objectContaining({
        handle: "anthropic/claude-sonnet-4-5",
        provider_type: "anthropic",
        max_context_window: 200000,
      }),
    ]);
  });

  test("passes model filters to the backend", async () => {
    const output = captureOutput();
    let listedWith: unknown;

    const exitCode = await runModelsSubcommand(
      [
        "--provider-name",
        "anthropic-work",
        "--provider-type",
        "anthropic",
        "--provider-category",
        "base,byok",
      ],
      {
        ...output.deps,
        getBackend: () =>
          makeBackend({
            onListModels: (options) => {
              listedWith = options;
            },
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(listedWith).toEqual({
      provider_name: "anthropic-work",
      provider_type: "anthropic",
      provider_category: ["base", "byok"],
    });
  });

  test("filters returned models when the backend ignores filters", async () => {
    const output = captureOutput();
    let listedWith: unknown;

    const exitCode = await runModelsSubcommand(
      ["--provider-name", "ollama", "--provider-type", "ollama"],
      {
        ...output.deps,
        getBackend: () =>
          makeBackend({
            models: [
              makeRuntimeModel({
                handle: "ollama/gemma4:latest",
                model: "ollama/gemma4:latest",
                model_endpoint_type: "ollama",
              }),
              makeModel({
                handle: "anthropic/claude-sonnet-4-5",
                provider_name: "anthropic",
                provider_type: "anthropic",
              }),
            ],
            onListModels: (options) => {
              listedWith = options;
            },
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(listedWith).toEqual({
      provider_name: "ollama",
      provider_type: "ollama",
    });
    const parsed = JSON.parse(output.stdout.join("\n"));
    expect(parsed).toEqual([
      expect.objectContaining({
        handle: "ollama/gemma4:latest",
        model_endpoint_type: "ollama",
      }),
    ]);
  });

  test("supports text output", async () => {
    const output = captureOutput();

    const exitCode = await runModelsSubcommand(["--format", "text"], {
      ...output.deps,
      getBackend: () =>
        makeBackend({
          models: [
            makeModel({
              handle: "letta/auto",
              provider_type: "letta",
              provider_name: "letta",
              name: "auto",
              display_name: "Auto",
            }),
          ],
        }),
    });

    expect(exitCode).toBe(0);
    expect(output.stdout.join("\n")).toContain("HANDLE");
    expect(output.stdout.join("\n")).toContain("letta/auto");
    expect(output.stdout.join("\n")).toContain("Auto");
  });

  test("refreshes BYOK providers when requested and supported", async () => {
    const output = captureOutput();
    let refreshed = false;

    const exitCode = await runModelsSubcommand(["--refresh"], {
      ...output.deps,
      getBackend: () => makeBackend({ byokProviderRefresh: true }),
      refreshByokProviders: async () => {
        refreshed = true;
      },
    });

    expect(exitCode).toBe(0);
    expect(refreshed).toBe(true);
  });

  test("prints usage for help", async () => {
    const output = captureOutput();

    const exitCode = await runModelsSubcommand(["help"], output.deps);

    expect(exitCode).toBe(0);
    expect(output.stdout.join("\n")).toContain("Usage:");
    expect(output.stdout.join("\n")).toContain("letta models [list]");
  });

  test("rejects invalid provider categories", async () => {
    const output = captureOutput();

    const exitCode = await runModelsSubcommand(
      ["--provider-category", "private"],
      output.deps,
    );

    expect(exitCode).toBe(1);
    expect(output.stderr.join("\n")).toContain("--provider-category");
  });
});
