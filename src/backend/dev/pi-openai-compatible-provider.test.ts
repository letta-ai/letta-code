import { describe, expect, test } from "bun:test";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import { createOpenAICompatiblePiProvider } from "./pi-openai-compatible-provider";

interface FakeEndpointState {
  models: unknown;
  requests: string[];
}

function fakeOpenAICompatibleFetch(state: FakeEndpointState): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    state.requests.push(url);
    if (url.endsWith("/models")) {
      return Response.json(state.models);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function endpointState(models: unknown): FakeEndpointState {
  return { models, requests: [] };
}

function modelOf(
  provider: ReturnType<typeof createOpenAICompatiblePiProvider>,
  id: string,
): { contextWindow: number; maxTokens: number } | undefined {
  const model = provider.getModels().find((m) => m.id === id);
  if (!model) return undefined;
  return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}

describe("createOpenAICompatiblePiProvider", () => {
  // A remote gateway's /v1/models is the only source of the served window:
  // clamping every custom endpoint to 128k makes the harness refuse to fill a
  // window the endpoint would happily serve (LET regression: a 1M-token
  // DashScope model published as 128k).
  test("publishes the context_length reported by /v1/models", async () => {
    const state = endpointState({
      data: [
        { id: "deepseek-v4-flash-free", context_length: 1000000 },
        { id: "big-pickle", context_length: 200000 },
      ],
    });
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "https://gateway.example/v1",
      fetchImpl: fakeOpenAICompatibleFetch(state),
    });
    expect(provider.getModels()).toHaveLength(0);
    await provider.refreshModels?.(testRefreshContext());

    expect(modelOf(provider, "deepseek-v4-flash-free")).toEqual({
      contextWindow: 1000000,
      maxTokens: 32000,
    });
    expect(modelOf(provider, "big-pickle")).toEqual({
      contextWindow: 200000,
      maxTokens: 32000,
    });
    expect(state.requests).toEqual(["https://gateway.example/v1/models"]);
  });

  test("honors alternative context spellings and max_output_tokens", async () => {
    const state = endpointState({
      data: [
        {
          id: "window-spelling",
          context_window: 200000,
          max_output_tokens: 8192,
        },
        { id: "alt-spelling", max_context_length: 400000 },
      ],
    });
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "https://gateway.example/v1",
      fetchImpl: fakeOpenAICompatibleFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    expect(modelOf(provider, "window-spelling")).toEqual({
      contextWindow: 200000,
      maxTokens: 8192,
    });
    expect(modelOf(provider, "alt-spelling")).toEqual({
      contextWindow: 400000,
      maxTokens: 32000,
    });
  });

  test("keeps the reported output cap bounded by the context window", async () => {
    const state = endpointState({
      data: [
        { id: "tiny-window", context_length: 4096, max_output_tokens: 999999 },
      ],
    });
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "https://gateway.example/v1",
      fetchImpl: fakeOpenAICompatibleFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    expect(modelOf(provider, "tiny-window")).toEqual({
      contextWindow: 4096,
      maxTokens: 4096,
    });
  });

  // Nothing reported — or garbage — keeps today's conservative defaults
  // (128k window / 32k output), never a NaN or negative window.
  test("falls back to the conservative default without usable metadata", async () => {
    const state = endpointState({
      data: [
        { id: "no-metadata" },
        { id: "negative", context_length: -5 },
        { id: "string", context_length: "1000" },
        { id: "zero", context_length: 0 },
      ],
    });
    const provider = createOpenAICompatiblePiProvider({
      baseURL: "https://gateway.example/v1",
      fetchImpl: fakeOpenAICompatibleFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    for (const id of ["no-metadata", "negative", "string", "zero"]) {
      expect(modelOf(provider, id)).toEqual({
        contextWindow: 128000,
        maxTokens: 32000,
      });
    }
  });
});
