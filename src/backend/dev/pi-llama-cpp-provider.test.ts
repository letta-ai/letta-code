import { describe, expect, test } from "bun:test";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import { createLlamaCppPiProvider } from "./pi-llama-cpp-provider";

interface FakeLlamaCppModelEntry {
  id: string;
  status?: string;
  inputModalities?: string[];
  nCtx?: number;
  nCtxTrain?: number;
  props?: { vision?: boolean; nCtx?: number };
}

interface FakeLlamaCppState {
  models: FakeLlamaCppModelEntry[];
  /** Native /models returns a plain OpenAI id list (no router metadata). */
  plainNativeList?: boolean;
  failModels?: boolean;
  failProps?: boolean;
  requests: string[];
}

/**
 * Routes by exact path like a real llama-server: native `/models` carries
 * router metadata; `/v1/models` is the plain OpenAI-compatible id list.
 */
function fakeLlamaCppFetch(state: FakeLlamaCppState): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    state.requests.push(url.pathname + url.search);
    if (url.pathname === "/models") {
      if (state.failModels) throw new Error("connection refused");
      if (state.plainNativeList) {
        return Response.json({
          data: state.models.map((model) => ({
            id: model.id,
            object: "model",
          })),
        });
      }
      return Response.json({
        data: state.models.map((model) => ({
          id: model.id,
          object: "model",
          ...(model.status ? { status: { value: model.status } } : {}),
          ...(model.inputModalities
            ? { architecture: { input_modalities: model.inputModalities } }
            : {}),
          ...(model.nCtx || model.nCtxTrain
            ? {
                meta: {
                  ...(model.nCtx ? { n_ctx: model.nCtx } : {}),
                  ...(model.nCtxTrain ? { n_ctx_train: model.nCtxTrain } : {}),
                },
              }
            : {}),
        })),
      });
    }
    if (url.pathname === "/v1/models") {
      if (state.failModels) throw new Error("connection refused");
      return Response.json({
        data: state.models.map((model) => ({ id: model.id, object: "model" })),
      });
    }
    if (url.pathname === "/props") {
      if (state.failProps) throw new Error("props unavailable");
      const modelId = url.searchParams.get("model");
      // Single-model servers ignore ?model=; router servers address by id.
      const model = modelId
        ? state.models.find((entry) => entry.id === modelId)
        : state.models[0];
      if (!model?.props) return new Response("not found", { status: 404 });
      return Response.json({
        modalities: { vision: model.props.vision ?? false, audio: false },
        ...(model.props.nCtx
          ? { default_generation_settings: { n_ctx: model.props.nCtx } }
          : {}),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("createLlamaCppPiProvider", () => {
  test("router mode: per-model native catalog metadata, no capability bleed", async () => {
    const state: FakeLlamaCppState = {
      models: [
        {
          id: "qwen3.6-27b.gguf",
          status: "loaded",
          inputModalities: ["text", "image"],
          nCtx: 32768,
        },
        {
          id: "some-vision-model.gguf",
          status: "loaded",
          inputModalities: ["text"],
          nCtxTrain: 8192,
        },
      ],
      requests: [],
    };
    const provider = createLlamaCppPiProvider({
      baseURL: "http://localhost:8080",
      fetchImpl: fakeLlamaCppFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    // Discovery reads the native catalog, not the OpenAI-compatible list.
    expect(state.requests).toContain("/models");
    expect(state.requests).not.toContain("/v1/models");

    const models = provider.getModels();
    const multimodal = models.find((m) => m.id === "qwen3.6-27b.gguf");
    expect(multimodal?.provider).toBe("llama-cpp");
    expect(multimodal?.input).toEqual(["text", "image"]);
    expect(multimodal?.contextWindow).toBe(32768);
    // Upstream contract: maxTokens = contextWindow, max_tokens field.
    expect(multimodal?.maxTokens).toBe(32768);
    expect(multimodal?.compat?.maxTokensField).toBe("max_tokens");

    // The other model must not inherit the first model's capabilities —
    // a "vision" filename grants nothing — and n_ctx_train is the
    // context fallback.
    const textOnly = models.find((m) => m.id === "some-vision-model.gguf");
    expect(textOnly?.input).toEqual(["text"]);
    expect(textOnly?.contextWindow).toBe(8192);
  });

  test("only loaded models publish from a router catalog", async () => {
    const provider = createLlamaCppPiProvider({
      baseURL: "http://localhost:8080",
      fetchImpl: fakeLlamaCppFetch({
        models: [
          { id: "loaded.gguf", status: "loaded", inputModalities: ["text"] },
          {
            id: "downloading.gguf",
            status: "downloading",
            inputModalities: ["text"],
          },
          {
            id: "sleeping.gguf",
            status: "sleeping",
            inputModalities: ["text"],
          },
        ],
        requests: [],
      }),
    });
    await provider.refreshModels?.(testRefreshContext());
    expect(provider.getModels().map((m) => m.id)).toEqual(["loaded.gguf"]);
  });

  test("single-model server without catalog metadata uses per-model /props", async () => {
    const state: FakeLlamaCppState = {
      plainNativeList: true,
      models: [
        {
          id: "multimodal.gguf",
          props: { vision: true, nCtx: 16384 },
        },
      ],
      requests: [],
    };
    const provider = createLlamaCppPiProvider({
      baseURL: "http://localhost:8080/v1",
      fetchImpl: fakeLlamaCppFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    const model = provider.getModels()[0];
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.contextWindow).toBe(16384);
    expect(model?.maxTokens).toBe(16384);
    expect(
      state.requests.some((url) =>
        url.includes("/props?model=multimodal.gguf"),
      ),
    ).toBe(true);
  });

  test("falls back to last-known models when metadata becomes unavailable", async () => {
    const state: FakeLlamaCppState = {
      plainNativeList: true,
      models: [{ id: "multimodal.gguf", props: { vision: true } }],
      requests: [],
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
      models: [
        { id: "model.gguf", status: "loaded", inputModalities: ["text"] },
      ],
      requests: [],
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
