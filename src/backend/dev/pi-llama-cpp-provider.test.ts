import { describe, expect, test } from "bun:test";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import { createLlamaCppPiProvider } from "./pi-llama-cpp-provider";

interface FakeLlamaCppState {
  modelIds: string[];
  props?: unknown;
  failProps?: boolean;
  failModels?: boolean;
}

function fakeLlamaCppFetch(state: FakeLlamaCppState): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      if (state.failModels) throw new Error("connection refused");
      return Response.json({
        data: state.modelIds.map((id) => ({ id, object: "model" })),
      });
    }
    if (url.endsWith("/props")) {
      if (state.failProps) throw new Error("props unavailable");
      return Response.json(state.props ?? {});
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("createLlamaCppPiProvider", () => {
  test("publishes vision and context size from /props engine metadata", async () => {
    const provider = createLlamaCppPiProvider({
      baseURL: "http://localhost:8080",
      fetchImpl: fakeLlamaCppFetch({
        // No vision marker in the model name: capabilities must come from
        // the engine, not the filename.
        modelIds: ["/models/qwen3.6-27b-Q4_K_M.gguf"],
        props: {
          modalities: { vision: true, audio: false },
          default_generation_settings: { n_ctx: 32768 },
        },
      }),
    });
    await provider.refreshModels?.(testRefreshContext());

    const model = provider.getModels()[0];
    expect(model?.provider).toBe("llama-cpp");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.contextWindow).toBe(32768);
    expect(model?.baseUrl).toBe("http://localhost:8080/v1");
  });

  test("text-only engine stays text-only regardless of name markers", async () => {
    const provider = createLlamaCppPiProvider({
      baseURL: "http://localhost:8080/v1",
      fetchImpl: fakeLlamaCppFetch({
        // "vision" in the filename must NOT grant image input.
        modelIds: ["/models/some-vision-model.gguf"],
        props: { modalities: { vision: false } },
      }),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()[0]?.input).toEqual(["text"]);
  });

  test("falls back to last-known models when /props is unavailable", async () => {
    const state: FakeLlamaCppState = {
      modelIds: ["/models/multimodal.gguf"],
      props: { modalities: { vision: true } },
    };
    const provider = createLlamaCppPiProvider({
      baseURL: "http://localhost:8080",
      fetchImpl: fakeLlamaCppFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()[0]?.input).toEqual(["text", "image"]);

    state.failProps = true;
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()[0]?.input).toEqual(["text", "image"]);
  });

  test("retains the last-known model list when refresh fails", async () => {
    const state: FakeLlamaCppState = {
      modelIds: ["/models/model.gguf"],
      props: {},
    };
    const provider = createLlamaCppPiProvider({
      baseURL: "http://localhost:8080",
      fetchImpl: fakeLlamaCppFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels()).toHaveLength(1);

    state.failModels = true;
    await expect(
      provider.refreshModels?.(testRefreshContext()),
    ).rejects.toThrow("connection refused");
    expect(provider.getModels()).toHaveLength(1);
  });
});
