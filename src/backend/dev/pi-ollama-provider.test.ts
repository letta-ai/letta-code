import { describe, expect, test } from "bun:test";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import { localEndpointNativeBaseURL } from "./pi-local-endpoint-provider";
import { resolvePiModelForAgent } from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import {
  createOllamaPiProvider,
  resolveOllamaServedContext,
} from "./pi-ollama-provider";

interface FakeOllamaState {
  tags: unknown;
  show: Record<string, unknown>;
  /** `GET /api/ps` payload; omitted means the endpoint answers 404. */
  ps?: unknown;
  failTags?: boolean;
  failShowFor?: Set<string>;
  requests: string[];
}

function fakeOllamaFetch(state: FakeOllamaState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    state.requests.push(url);
    if (url.endsWith("/api/tags")) {
      if (state.failTags) throw new Error("connection refused");
      return Response.json(state.tags);
    }
    if (url.endsWith("/api/ps")) {
      if (state.ps === undefined)
        return new Response("not found", { status: 404 });
      return Response.json(state.ps);
    }
    if (url.endsWith("/api/show")) {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (state.failShowFor?.has(body.model)) {
        throw new Error("show failed");
      }
      const show = state.show[body.model];
      if (!show) return new Response("not found", { status: 404 });
      return Response.json(show);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function qwenState(): FakeOllamaState {
  return {
    tags: {
      models: [{ name: "qwen3.6:27b" }, { name: "smol-text:3b" }],
    },
    show: {
      // Authoritative engine metadata: multimodal despite a model name with
      // no "vl"/"vision"/"llava" marker (the LET-10127 regression).
      "qwen3.6:27b": {
        capabilities: ["completion", "vision", "tools", "thinking"],
        model_info: {
          "general.architecture": "qwen36",
          "qwen36.context_length": 262144,
        },
      },
      "smol-text:3b": {
        capabilities: ["completion", "tools"],
        model_info: {
          "general.architecture": "smol",
          "smol.context_length": 32768,
        },
      },
    },
    requests: [],
  };
}

describe("localEndpointNativeBaseURL", () => {
  test("strips a trailing /v1", () => {
    expect(localEndpointNativeBaseURL("http://localhost:11434/v1")).toBe(
      "http://localhost:11434",
    );
    expect(localEndpointNativeBaseURL("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434",
    );
    expect(localEndpointNativeBaseURL("http://localhost:11434")).toBe(
      "http://localhost:11434",
    );
  });
});

describe("resolveOllamaServedContext", () => {
  test("cancels a pending model load with the turn", async () => {
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (!String(input).endsWith("/api/generate")) {
        return Response.json({ models: [] });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = resolveOllamaServedContext({
      baseURL: "http://localhost:11434",
      modelId: "qwen3.6:27b",
      fetchImpl,
      signal: controller.signal,
    });

    controller.abort(new Error("turn cancelled"));
    await expect(pending).rejects.toThrow("turn cancelled");
  });

  test("cancels the required post-load status probe with the turn", async () => {
    let statusStarted = () => {};
    const started = new Promise<void>((resolve) => {
      statusStarted = resolve;
    });
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).endsWith("/api/generate")) return Response.json({});
      statusStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = resolveOllamaServedContext({
      baseURL: "http://localhost:11434",
      modelId: "qwen3.6:27b",
      fetchImpl,
      signal: controller.signal,
    });

    await started;
    controller.abort(new Error("turn cancelled"));
    await expect(pending).rejects.toThrow("turn cancelled");
  });
});

describe("createOllamaPiProvider", () => {
  test("publishes vision capability from /api/show, not the model name", async () => {
    const state = qwenState();
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    const refreshContext = testRefreshContext();

    expect(provider.getModels()).toHaveLength(0);
    await provider.refreshModels?.(refreshContext);

    const qwen = provider.getModels().find((m) => m.id === "qwen3.6:27b");
    expect(qwen).toBeDefined();
    expect(qwen?.input).toEqual(["text", "image"]);
    expect(qwen?.reasoning).toBe(true);
    expect(qwen?.contextWindow).toBe(128000);
    expect(qwen?.api).toBe("openai-completions");
    expect(qwen?.baseUrl).toBe("http://localhost:11434/v1");

    const text = provider.getModels().find((m) => m.id === "smol-text:3b");
    expect(text?.input).toEqual(["text"]);
    expect(text?.reasoning).toBe(false);
    expect(text?.contextWindow).toBe(32768);
  });

  // Ollama serves OLLAMA_CONTEXT_LENGTH, not the GGUF maximum, and silently
  // truncates anything longer. Publishing the architectural maximum makes the
  // harness think it has room it does not have, so compaction never fires and
  // the engine drops the front of the prompt — persona and memory included.
  test("prefers the runtime window from /api/ps over GGUF metadata", async () => {
    const state = qwenState();
    state.ps = {
      models: [{ name: "qwen3.6:27b", context_length: 32768 }],
    };
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.contextWindow,
    ).toBe(32768);
  });

  test("does not apply another loaded model's window as an endpoint default", async () => {
    const state = qwenState();
    // A client can load each model with a different num_ctx. `/api/ps` is
    // authoritative only for the exact model identity in that record.
    state.ps = { models: [{ name: "smol-text:3b", context_length: 8192 }] };
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.contextWindow,
    ).toBe(128000);
    expect(
      provider.getModels().find((m) => m.id === "smol-text:3b")?.contextWindow,
    ).toBe(8192);
  });

  test("falls back to GGUF metadata when /api/ps is unavailable", async () => {
    const state = qwenState();
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    await provider.refreshModels?.(testRefreshContext());

    // 262144 in metadata, clamped by the harness default.
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.contextWindow,
    ).toBe(128000);
  });

  test("republishes when the runtime window changes without a digest change", async () => {
    const state: FakeOllamaState = {
      tags: { models: [{ name: "qwen3.6:27b", digest: "sha256-aaa" }] },
      show: { "qwen3.6:27b": { capabilities: ["completion"] } },
      ps: { models: [{ name: "qwen3.6:27b", context_length: 8192 }] },
      requests: [],
    };
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    const refreshContext = testRefreshContext();
    await provider.refreshModels?.(refreshContext);
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.contextWindow,
    ).toBe(8192);

    // Daemon restarted with a larger OLLAMA_CONTEXT_LENGTH: same blob, new
    // window. The digest fast-path must not pin the stale value.
    state.ps = { models: [{ name: "qwen3.6:27b", context_length: 65536 }] };
    await provider.refreshModels?.(refreshContext);
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.contextWindow,
    ).toBe(65536);
  });

  test("skips /api/show when the tag digest is unchanged", async () => {
    const state: FakeOllamaState = {
      tags: { models: [{ name: "qwen3.6:27b", digest: "sha256-aaa" }] },
      show: {
        "qwen3.6:27b": {
          capabilities: ["completion", "vision", "tools", "thinking"],
        },
      },
      requests: [],
    };
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    const refreshContext = testRefreshContext();

    await provider.refreshModels?.(refreshContext);
    const showCalls = () =>
      state.requests.filter((url) => url.endsWith("/api/show")).length;
    expect(showCalls()).toBe(1);

    // Unchanged digest: refresh reuses the published Model, no metadata read.
    await provider.refreshModels?.(refreshContext);
    expect(showCalls()).toBe(1);
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.input,
    ).toEqual(["text", "image"]);

    // New digest (model updated): metadata is re-read.
    state.tags = { models: [{ name: "qwen3.6:27b", digest: "sha256-bbb" }] };
    await provider.refreshModels?.(refreshContext);
    expect(showCalls()).toBe(2);
  });

  test("retains the last-known model list when refresh fails", async () => {
    const state = qwenState();
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    const refreshContext = testRefreshContext();
    await provider.refreshModels?.(refreshContext);
    expect(provider.getModels()).toHaveLength(2);

    state.failTags = true;
    await expect(provider.refreshModels?.(refreshContext)).rejects.toThrow(
      "connection refused",
    );
    expect(provider.getModels()).toHaveLength(2);
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.input,
    ).toEqual(["text", "image"]);
  });

  test("keeps last-known capabilities when /api/show fails for one model", async () => {
    const state = qwenState();
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    const refreshContext = testRefreshContext();
    await provider.refreshModels?.(refreshContext);

    state.failShowFor = new Set(["qwen3.6:27b"]);
    await provider.refreshModels?.(refreshContext);
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.input,
    ).toEqual(["text", "image"]);
  });

  test("publishes a text-only model when /api/show never succeeded", async () => {
    const state = qwenState();
    state.failShowFor = new Set(["qwen3.6:27b"]);
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    const refreshContext = testRefreshContext();
    await provider.refreshModels?.(refreshContext);
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.input,
    ).toEqual(["text"]);
  });
});

describe("createOllamaPiProvider as Ollama Cloud", () => {
  test("publishes under the ollama-cloud provider id and sends the API key", async () => {
    const state = qwenState();
    const authHeaders: Array<string | undefined> = [];
    const baseFetch = fakeOllamaFetch(state);
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      authHeaders.push(
        (init?.headers as Record<string, string> | undefined)?.Authorization,
      );
      return baseFetch(input as never, init);
    }) as typeof fetch;

    const provider = createOllamaPiProvider({
      providerId: "ollama-cloud",
      baseURL: "https://ollama.example.test",
      apiKey: "cloud-key",
      fetchImpl,
    });
    const refreshContext = testRefreshContext();
    expect(provider.id).toBe("ollama-cloud");
    expect(provider.name).toBe("Ollama Cloud");

    await provider.refreshModels?.(refreshContext);
    const qwen = provider.getModels().find((m) => m.id === "qwen3.6:27b");
    expect(qwen?.provider).toBe("ollama-cloud");
    expect(qwen?.input).toEqual(["text", "image"]);
    expect(qwen?.contextWindow).toBe(128000);
    expect(authHeaders.every((header) => header === "Bearer cloud-key")).toBe(
      true,
    );
  });

  test("turn resolution does not require local-daemon serving APIs", async () => {
    const previousApiKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "cloud-key";
    const state = qwenState();
    const fetchImpl = fakeOllamaFetch(state);
    const runtime = new LocalPiModelsRuntime({ fetchImpl });

    try {
      const resolved = await resolvePiModelForAgent(
        "ollama-cloud/qwen3.6:27b",
        {
          provider_type: "ollama_cloud",
          context_window_limit: 262144,
        },
        { modelsRuntime: runtime },
      );
      expect(resolved.model.contextWindow).toBe(262144);
      expect(state.requests.some((url) => url.endsWith("/api/generate"))).toBe(
        false,
      );
      // Catalog discovery may probe /api/ps best-effort and receive 404. Turn
      // resolution must not require a local-daemon served-window result.
      expect(state.requests.some((url) => url.endsWith("/api/ps"))).toBe(true);
    } finally {
      if (previousApiKey === undefined) delete process.env.OLLAMA_API_KEY;
      else process.env.OLLAMA_API_KEY = previousApiKey;
    }
  });
});

describe("defaults when engine metadata is missing", () => {
  test("publishes conservative defaults (text-only, default context window)", async () => {
    const state: FakeOllamaState = {
      tags: { models: [{ name: "some-model" }] },
      show: { "some-model": { capabilities: ["completion"] } },
      requests: [],
    };
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    const refreshContext = testRefreshContext();
    await provider.refreshModels?.(refreshContext);
    const model = provider.getModels().find((m) => m.id === "some-model");
    expect(model?.contextWindow).toBe(128000);
    expect(model?.input).toEqual(["text"]);
    expect(model?.provider).toBe("ollama");
  });
});
