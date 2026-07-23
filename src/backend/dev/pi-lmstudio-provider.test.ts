import { describe, expect, test } from "bun:test";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import { createLmStudioPiProvider } from "./pi-lmstudio-provider";

interface FakeLmStudioState {
  nativeModels?: unknown[];
  failNative?: boolean;
  openAIModelIds?: string[];
  failOpenAI?: boolean;
}

function fakeLmStudioFetch(state: FakeLmStudioState): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/v0/models")) {
      if (state.failNative || !state.nativeModels) {
        throw new Error("native api unavailable");
      }
      return Response.json({ object: "list", data: state.nativeModels });
    }
    if (url.endsWith("/v1/models")) {
      if (state.failOpenAI) throw new Error("connection refused");
      return Response.json({
        data: (state.openAIModelIds ?? []).map((id) => ({
          id,
          object: "model",
        })),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("createLmStudioPiProvider", () => {
  test("publishes capabilities from native /api/v0/models metadata", async () => {
    const provider = createLmStudioPiProvider({
      baseURL: "http://127.0.0.1:1234",
      fetchImpl: fakeLmStudioFetch({
        nativeModels: [
          {
            // No vl/vision marker in the id; type "vlm" is authoritative.
            id: "qwen3.6-27b",
            object: "model",
            type: "vlm",
            max_context_length: 262144,
          },
          {
            id: "smol-text-3b",
            object: "model",
            type: "llm",
            capabilities: ["tool_use"],
            max_context_length: 8192,
          },
          {
            id: "text-embedding-nomic",
            object: "model",
            type: "embeddings",
          },
        ],
      }),
    });
    await provider.refreshModels?.(testRefreshContext());

    const models = provider.getModels();
    const vlm = models.find((m) => m.id === "qwen3.6-27b");
    expect(vlm?.provider).toBe("lmstudio");
    expect(vlm?.input).toEqual(["text", "image"]);
    expect(vlm?.contextWindow).toBe(262144);

    const llm = models.find((m) => m.id === "smol-text-3b");
    expect(llm?.input).toEqual(["text"]);
    expect(llm?.contextWindow).toBe(8192);

    // Embedding models are excluded from the chat model list.
    expect(models.some((m) => m.id === "text-embedding-nomic")).toBe(false);
  });

  test("without native metadata, capabilities are explicitly unknown (text-only)", async () => {
    const provider = createLmStudioPiProvider({
      baseURL: "http://127.0.0.1:1234/v1",
      fetchImpl: fakeLmStudioFetch({
        failNative: true,
        // "llava" in the id must not grant image input on the fallback path.
        openAIModelIds: ["llava-1.6-7b"],
      }),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()[0]?.input).toEqual(["text"]);
  });

  test("fallback path keeps last-known capabilities per model", async () => {
    const state: FakeLmStudioState = {
      nativeModels: [{ id: "qwen3.6-27b", object: "model", type: "vlm" }],
      openAIModelIds: ["qwen3.6-27b"],
    };
    const provider = createLmStudioPiProvider({
      baseURL: "http://127.0.0.1:1234",
      fetchImpl: fakeLmStudioFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()[0]?.input).toEqual(["text", "image"]);

    state.failNative = true;
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()[0]?.input).toEqual(["text", "image"]);
  });

  test("retains the last-known model list when refresh fails entirely", async () => {
    const state: FakeLmStudioState = {
      nativeModels: [{ id: "model-a", object: "model", type: "llm" }],
    };
    const provider = createLmStudioPiProvider({
      baseURL: "http://127.0.0.1:1234",
      fetchImpl: fakeLmStudioFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()).toHaveLength(1);

    state.failNative = true;
    state.failOpenAI = true;
    expect(provider.refreshModels?.(testRefreshContext())).rejects.toThrow();
    expect(provider.getModels()).toHaveLength(1);
  });
});
