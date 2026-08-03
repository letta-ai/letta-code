import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { type Instance, render } from "ink";
import stripAnsi from "strip-ansi";
import { clearAvailableModelsCache } from "@/agent/available-models";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  clearRegisteredPiProviders,
  listRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { settingsManager } from "@/settings-manager";
import { deriveToolsetFromModel } from "@/tools/toolset";
import { ModelSelector, type ModelSelectorSelection } from "./ModelSelector";
import { ProviderSelector } from "./ProviderSelector";

class CaptureStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }

  read(): string {
    return stripAnsi(this.chunks.join(""));
  }

  reset(): void {
    this.chunks = [];
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

async function waitForOutput(
  stdout: CaptureStream,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  let output = stdout.read();
  while (!output.includes(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    output = stdout.read();
  }
  if (!output.includes(text)) {
    throw new Error(
      `Timed out waiting for ${JSON.stringify(text)}. Last output: ${JSON.stringify(output.slice(-2000))}`,
    );
  }
}

function registerTestProvider(): void {
  registerPiProvider("late-provider", {
    name: "Aardvark Late Provider",
    api: "openai-completions",
    baseUrl: "https://late-provider.test/v1",
    models: [
      {
        id: "late-model",
        name: "Late Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 16000,
      },
    ],
  });
}

function createModelBackend(): Backend {
  const backend = new FakeHeadlessBackend();
  backend.listModels = async () => {
    const registeredModels = listRegisteredPiProviders().flatMap((provider) =>
      (provider.config.models ?? []).map((model) => ({
        handle: `${provider.providerName}/${model.id}`,
        display_name: model.name,
        provider_type: provider.providerName,
      })),
    );
    return [
      {
        handle: "baseline/model",
        display_name: "Baseline Model",
        provider_type: "baseline",
      },
      ...registeredModels,
    ] as Awaited<ReturnType<Backend["listModels"]>>;
  };
  return backend;
}

const renderedInstances = new Set<Instance>();
let previousBackendMode: BackendMode;

afterEach(() => {
  for (const instance of renderedInstances) {
    instance.unmount();
    instance.cleanup();
  }
  renderedInstances.clear();
  clearAvailableModelsCache();
  clearRegisteredPiProviders();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
});

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  __testSetBackend(createModelBackend());
  await settingsManager.initialize();
});

describe("provider mod selector refresh", () => {
  test("refreshes an open model selector when a provider registers", async () => {
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    const instance = render(
      <ModelSelector
        localModelCatalog
        onCancel={() => {}}
        onSelect={() => {}}
      />,
      {
        stdout,
        stdin: createInputStream(),
        // Ink suppresses dynamic output writes when CI=true unless debug mode
        // is enabled, so captured selector frames would otherwise stay empty.
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    renderedInstances.add(instance);

    await waitForOutput(stdout, "baseline/model");
    expect(stdout.read()).toContain("baseline/model");
    stdout.reset();

    registerTestProvider();
    await waitForOutput(stdout, "late-provider/late-model");

    expect(stdout.read()).toContain("late-provider/late-model");
  });

  test("preserves OAuth provider identity for custom aliases in the All category", async () => {
    const handle = "chatgpt-work/gpt-5.6-sol";
    const backend = new FakeHeadlessBackend();
    backend.listModels = async () =>
      [
        {
          handle,
          display_name: "gpt-5.6-sol",
          provider_type: "chatgpt_oauth",
          provider_category: "byok",
        },
      ] as never;
    __testSetBackend(backend);
    clearAvailableModelsCache();

    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    const stdin = createInputStream();
    let resolveSelection: (selection: ModelSelectorSelection) => void =
      () => {};
    const selected = new Promise<ModelSelectorSelection>((resolve) => {
      resolveSelection = resolve;
    });
    const instance = render(
      <ModelSelector
        onCancel={() => {}}
        onSelect={(selection) => resolveSelection(selection)}
      />,
      {
        stdout,
        stdin,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    renderedInstances.add(instance);

    await waitForOutput(stdout, handle);
    stdin.push("\r");
    const selection = await selected;

    expect(selection).toMatchObject({
      handle,
      updateArgs: { provider_type: "chatgpt_oauth" },
    });
    expect(
      deriveToolsetFromModel(
        selection.handle,
        selection.updateArgs?.provider_type as string,
      ),
    ).toBe("codex");
  });

  test("refreshes an open provider selector when a provider registers", async () => {
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    const instance = render(<ProviderSelector onCancel={() => {}} />, {
      stdout,
      stdin: createInputStream(),
      // See the ModelSelector render above: CI mode only emits dynamic frames
      // to a captured stream when Ink debug rendering is enabled.
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    renderedInstances.add(instance);

    await waitForOutput(stdout, "Connect your LLM API keys");
    expect(stdout.read()).not.toContain("Aardvark Late Provider");
    stdout.reset();

    registerTestProvider();
    await waitForOutput(stdout, "Aardvark Late Provider");

    expect(stdout.read()).toContain("Aardvark Late Provider");
  });
});
