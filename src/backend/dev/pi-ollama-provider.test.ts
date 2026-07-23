import { describe, expect, test } from "bun:test";
import {
  createOllamaPiProvider,
  ollamaModelFromShowResponse,
  ollamaNativeBaseURL,
} from "./pi-ollama-provider";

interface FakeOllamaState {
  tags: unknown;
  show: Record<string, unknown>;
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
      },
    },
    requests: [],
  };
}

describe("ollamaNativeBaseURL", () => {
  test("strips a trailing /v1", () => {
    expect(ollamaNativeBaseURL("http://localhost:11434/v1")).toBe(
      "http://localhost:11434",
    );
    expect(ollamaNativeBaseURL("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434",
    );
    expect(ollamaNativeBaseURL("http://localhost:11434")).toBe(
      "http://localhost:11434",
    );
  });
});

describe("createOllamaPiProvider", () => {
  test("publishes vision capability from /api/show, not the model name", async () => {
    const state = qwenState();
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });

    expect(provider.getModels()).toHaveLength(0);
    await provider.refreshModels?.();

    const qwen = provider.getModels().find((m) => m.id === "qwen3.6:27b");
    expect(qwen).toBeDefined();
    expect(qwen?.input).toEqual(["text", "image"]);
    expect(qwen?.reasoning).toBe(true);
    expect(qwen?.contextWindow).toBe(262144);
    expect(qwen?.api).toBe("openai-completions");
    expect(qwen?.baseUrl).toBe("http://localhost:11434/v1");

    const text = provider.getModels().find((m) => m.id === "smol-text:3b");
    expect(text?.input).toEqual(["text"]);
    expect(text?.reasoning).toBe(false);
  });

  test("retains the last-known model list when refresh fails", async () => {
    const state = qwenState();
    const provider = createOllamaPiProvider({
      baseURL: "http://localhost:11434",
      fetchImpl: fakeOllamaFetch(state),
    });
    await provider.refreshModels?.();
    expect(provider.getModels()).toHaveLength(2);

    state.failTags = true;
    expect(provider.refreshModels?.()).rejects.toThrow("connection refused");
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
    await provider.refreshModels?.();

    state.failShowFor = new Set(["qwen3.6:27b"]);
    await provider.refreshModels?.();
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
    await provider.refreshModels?.();
    expect(
      provider.getModels().find((m) => m.id === "qwen3.6:27b")?.input,
    ).toEqual(["text"]);
  });
});

describe("ollamaModelFromShowResponse", () => {
  test("defaults context window when engine metadata is missing", () => {
    const model = ollamaModelFromShowResponse({
      modelId: "some-model",
      baseURL: "http://localhost:11434",
      show: { capabilities: ["completion"] },
    });
    expect(model.contextWindow).toBe(128000);
    expect(model.input).toEqual(["text"]);
    expect(model.provider).toBe("ollama");
  });
});
