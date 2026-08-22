import { describe, expect, test } from "bun:test";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import {
  createOpenAICompatiblePiProvider,
  openAICompatibleTokenLimitRecord,
  setOpenAICompatibleTokenLimits,
} from "./pi-openai-compatible-provider";
import { OPENAI_COMPATIBLE_PI_PROVIDER_ID } from "./pi-provider-registry";

interface FakeOpenAIState {
  models?: unknown[];
  fail?: boolean;
}

function fakeOpenAIFetch(state: FakeOpenAIState): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      if (state.fail) throw new Error("connection refused");
      return Response.json({ object: "list", data: state.models ?? [] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("createOpenAICompatiblePiProvider", () => {
  test("publishes provider-advertised token limits from /v1/models", async () => {
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "http://127.0.0.1:9999",
      fetchImpl: fakeOpenAIFetch({
        models: [
          {
            id: "small-30k",
            object: "model",
            max_input_tokens: 30000,
            max_output_tokens: 16384,
          },
          {
            id: "mid-100k",
            object: "model",
            max_input_tokens: 100000,
            max_output_tokens: 40000,
          },
          {
            id: "oversized-272k",
            object: "model",
            max_input_tokens: 272000,
            max_output_tokens: 128000,
          },
        ],
      }),
    });
    await provider.refreshModels?.(testRefreshContext());

    const models = provider.getModels();
    const small = models.find((m) => m.id === "small-30k");
    expect(small?.contextWindow).toBe(30000);
    expect(small?.maxTokens).toBe(16384);
    const mid = models.find((m) => m.id === "mid-100k");
    expect(mid?.contextWindow).toBe(100000);
    expect(mid?.maxTokens).toBe(40000);
    // Oversized windows stay clamped to the harness default cap.
    const oversized = models.find((m) => m.id === "oversized-272k");
    expect(oversized?.contextWindow).toBe(128000);
    expect(oversized?.maxTokens).toBe(128000);
  });

  test("ignores malformed limit fields", async () => {
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "http://127.0.0.1:9999",
      fetchImpl: fakeOpenAIFetch({
        models: [
          {
            id: "malformed",
            object: "model",
            max_input_tokens: true,
            max_output_tokens: "16384",
          },
          {
            id: "zero-limits",
            object: "model",
            max_input_tokens: 0,
            max_output_tokens: 0,
          },
          {
            id: "negative",
            object: "model",
            max_input_tokens: -5,
            max_output_tokens: -1,
          },
          {
            id: "fractional",
            object: "model",
            max_input_tokens: 1.5,
            max_output_tokens: 2.5,
          },
        ],
      }),
    });
    await provider.refreshModels?.(testRefreshContext());

    const models = provider.getModels();
    for (const id of ["malformed", "zero-limits", "negative", "fractional"]) {
      const model = models.find((m) => m.id === id);
      expect(model?.contextWindow).toBe(128000);
      expect(model?.maxTokens).toBe(32000);
    }
  });

  test("falls back per-field when only one limit is advertised", async () => {
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "http://127.0.0.1:9999",
      fetchImpl: fakeOpenAIFetch({
        models: [
          { id: "input-only", object: "model", max_input_tokens: 60000 },
          { id: "output-only", object: "model", max_output_tokens: 20000 },
        ],
      }),
    });
    await provider.refreshModels?.(testRefreshContext());

    const models = provider.getModels();
    const inputOnly = models.find((m) => m.id === "input-only");
    expect(inputOnly?.contextWindow).toBe(60000);
    expect(inputOnly?.maxTokens).toBe(32000);
    const outputOnly = models.find((m) => m.id === "output-only");
    expect(outputOnly?.contextWindow).toBe(128000);
    expect(outputOnly?.maxTokens).toBe(20000);
  });

  test("refresh updates limits when the provider changes its advertised values", async () => {
    const state: FakeOpenAIState = {
      models: [
        {
          id: "changing",
          object: "model",
          max_input_tokens: 30000,
          max_output_tokens: 16384,
        },
      ],
    };
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "http://127.0.0.1:9999",
      fetchImpl: fakeOpenAIFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(
      provider.getModels().find((m) => m.id === "changing")?.contextWindow,
    ).toBe(30000);
    expect(
      provider.getModels().find((m) => m.id === "changing")?.maxTokens,
    ).toBe(16384);

    state.models = [
      {
        id: "changing",
        object: "model",
        max_input_tokens: 100000,
        max_output_tokens: 40000,
      },
    ];
    await provider.refreshModels?.(testRefreshContext());
    expect(
      provider.getModels().find((m) => m.id === "changing")?.contextWindow,
    ).toBe(100000);
    expect(
      provider.getModels().find((m) => m.id === "changing")?.maxTokens,
    ).toBe(40000);
  });
});

describe("openai-compatible token-limit sidecar", () => {
  const PROVIDER_ID = OPENAI_COMPATIBLE_PI_PROVIDER_ID;

  function makeProvider(models: unknown[]) {
    return createOpenAICompatiblePiProvider({
      baseURL: "http://127.0.0.1:9999",
      fetchImpl: fakeOpenAIFetch({ models }),
    });
  }

  test("exposes advertised and effective limits side by side", async () => {
    setOpenAICompatibleTokenLimits(PROVIDER_ID, []);
    const provider = makeProvider([
      {
        id: "oversized-272k",
        object: "model",
        max_input_tokens: 272000,
        max_output_tokens: 200000,
      },
    ]);
    await provider.refreshModels?.(testRefreshContext());
    const record = openAICompatibleTokenLimitRecord(
      PROVIDER_ID,
      "oversized-272k",
    );
    // The caller can tell the endpoint reported 272k/200k while the harness
    // ceiling produced the effective 128k window and cap.
    expect(record?.advertisedContextLength).toBe(272000);
    expect(record?.effectiveContextWindow).toBe(128000);
    expect(record?.advertisedMaxOutputTokens).toBe(200000);
    expect(record?.effectiveMaxTokens).toBe(128000);
  });

  test("keeps unadvertised fields undefined instead of inventing them", async () => {
    setOpenAICompatibleTokenLimits(PROVIDER_ID, []);
    const provider = makeProvider([{ id: "bare", object: "model" }]);
    await provider.refreshModels?.(testRefreshContext());
    const record = openAICompatibleTokenLimitRecord(PROVIDER_ID, "bare");
    expect(record?.advertisedContextLength).toBeUndefined();
    expect(record?.advertisedMaxOutputTokens).toBeUndefined();
    // Effective values still exist — the harness defaults the Model ships with.
    expect(record?.effectiveContextWindow).toBe(128000);
    expect(typeof record?.effectiveMaxTokens).toBe("number");
  });

  test("refresh drops records for models the endpoint no longer lists", async () => {
    setOpenAICompatibleTokenLimits(PROVIDER_ID, []);
    const provider = makeProvider([
      { id: "kept", object: "model" },
      { id: "dropped", object: "model" },
    ]);
    await provider.refreshModels?.(testRefreshContext());
    expect(
      openAICompatibleTokenLimitRecord(PROVIDER_ID, "dropped"),
    ).toBeDefined();

    const second = makeProvider([{ id: "kept", object: "model" }]);
    await second.refreshModels?.(testRefreshContext());
    expect(openAICompatibleTokenLimitRecord(PROVIDER_ID, "kept")).toBeDefined();
    expect(
      openAICompatibleTokenLimitRecord(PROVIDER_ID, "dropped"),
    ).toBeUndefined();
  });
});
