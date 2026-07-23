import { afterEach, describe, expect, test } from "bun:test";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import { createModPiProvider } from "./pi-mod-provider";
import { resolvePiModelForAgent } from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import {
  getRegisteredPiProvider,
  type PiProviderModelRegistration,
  registerPiProvider,
  unregisterPiProvider,
} from "./pi-provider-mod-registry";

const PROVIDER = "modtest-acme";

function model(
  id: string,
  overrides: Partial<PiProviderModelRegistration> = {},
): PiProviderModelRegistration {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 16000,
    ...overrides,
  };
}

describe("createModPiProvider", () => {
  afterEach(() => {
    unregisterPiProvider(PROVIDER);
  });

  test("publishes statically declared models as complete pi-ai Models", () => {
    registerPiProvider(PROVIDER, {
      name: "Acme",
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [
        model("acme-large", { input: ["text", "image"], reasoning: true }),
      ],
    });
    const provider = createModPiProvider({
      registered: getRegisteredPiProvider(PROVIDER)!,
    });

    expect(provider.id).toBe(PROVIDER);
    expect(provider.refreshModels).toBeUndefined();
    const published = provider.getModels();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: "acme-large",
      provider: PROVIDER,
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 100000,
    });
  });

  test("listModels becomes provider refresh with last-known retention", async () => {
    let fail = false;
    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [model("static-seed")],
      listModels: () => {
        if (fail) throw new Error("endpoint down");
        return [model("dynamic-1", { input: ["text", "image"] })];
      },
    });
    const provider = createModPiProvider({
      registered: getRegisteredPiProvider(PROVIDER)!,
    });

    // Static declaration seeds the list before the first refresh.
    expect(provider.getModels().map((m) => m.id)).toEqual(["static-seed"]);

    // pi-ai 0.81 merges the static baseline with the dynamic overlay by id;
    // discoveries extend the declared baseline rather than replacing it.
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels().map((m) => m.id)).toEqual([
      "static-seed",
      "dynamic-1",
    ]);
    expect(
      provider.getModels().find((m) => m.id === "dynamic-1")?.input,
    ).toEqual(["text", "image"]);

    fail = true;
    expect(provider.refreshModels?.(testRefreshContext())).rejects.toThrow(
      "endpoint down",
    );
    expect(provider.getModels().map((m) => m.id)).toEqual([
      "static-seed",
      "dynamic-1",
    ]);
  });
});

describe("LocalPiModelsRuntime mod provider integration", () => {
  afterEach(() => {
    unregisterPiProvider(PROVIDER);
  });

  test("turn resolution returns the provider-published Model instance", async () => {
    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [model("acme-large")],
    });
    const runtime = new LocalPiModelsRuntime();

    const resolved = await resolvePiModelForAgent(
      `${PROVIDER}/acme-large`,
      {},
      { modelsRuntime: runtime },
    );
    expect(resolved.model).toBe(runtime.getModel(PROVIDER, "acme-large")!);
    expect(resolved.model.provider).toBe(PROVIDER);
  });

  test("re-registration rebuilds only that provider; unregistration removes it", async () => {
    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [model("v1-model")],
    });
    const runtime = new LocalPiModelsRuntime();
    expect(runtime.getModel(PROVIDER, "v1-model")).toBeDefined();
    const builtinBefore = runtime.getModels("anthropic");

    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v2",
      models: [model("v2-model")],
    });
    expect(runtime.getModel(PROVIDER, "v1-model")).toBeUndefined();
    expect(runtime.getModel(PROVIDER, "v2-model")?.baseUrl).toBe(
      "https://api.acme.test/v2",
    );
    expect(runtime.getModels("anthropic")[0]).toBe(builtinBefore[0]!);
    expect(runtime.getModels("anthropic")).toHaveLength(builtinBefore.length);

    unregisterPiProvider(PROVIDER);
    expect(runtime.isRuntimeManagedProvider(PROVIDER)).toBe(false);
    expect(runtime.getModels(PROVIDER)).toHaveLength(0);
  });
});
