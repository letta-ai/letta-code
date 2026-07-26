import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { clearAvailableModelsCache } from "@/agent/available-models";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  clearRegisteredPiProviders,
  listRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { settingsManager } from "@/settings-manager";
import { ModelSelector } from "./ModelSelector";
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
  const deadline = Date.now() + 1000;
  while (!stdout.read().includes(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
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

afterEach(() => {
  clearAvailableModelsCache();
  clearRegisteredPiProviders();
  __testSetBackend(null);
});

beforeEach(async () => {
  await settingsManager.initialize();
});

describe("provider mod selector refresh", () => {
  test("refreshes an open model selector when a provider registers", async () => {
    __testSetBackend(createModelBackend());
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
        debug: false,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    await waitForOutput(stdout, "baseline/model");
    expect(stdout.read()).toContain("baseline/model");
    stdout.reset();

    registerTestProvider();
    await waitForOutput(stdout, "late-provider/late-model");

    expect(stdout.read()).toContain("late-provider/late-model");
    instance.unmount();
    instance.cleanup();
  });

  test("refreshes an open provider selector when a provider registers", async () => {
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    const instance = render(<ProviderSelector onCancel={() => {}} />, {
      stdout,
      stdin: createInputStream(),
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stdout.read()).not.toContain("Aardvark Late Provider");
    stdout.reset();

    registerTestProvider();
    await waitForOutput(stdout, "Aardvark Late Provider");

    expect(stdout.read()).toContain("Aardvark Late Provider");
    instance.unmount();
    instance.cleanup();
  });
});
