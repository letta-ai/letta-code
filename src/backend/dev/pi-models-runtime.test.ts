import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLocalModels } from "@/backend/local/local-model-config";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import { resolvePiModelForAgent } from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface FakeOllamaModel {
  id: string;
  capabilities: string[];
  contextLength?: number;
}

interface FakeOllamaServer {
  url: string;
  chatBodies: Array<Record<string, unknown>>;
  stop(): void;
}

function sseChatResponse(modelId: string): Response {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const body = [
    chunk({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function startFakeOllama(models: FakeOllamaModel[]): FakeOllamaServer {
  const chatBodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") {
        return Response.json({
          models: models.map((model) => ({ name: model.id })),
        });
      }
      if (url.pathname === "/api/show") {
        const body = (await request.json()) as { model: string };
        const model = models.find((entry) => entry.id === body.model);
        if (!model) return new Response("not found", { status: 404 });
        return Response.json({
          capabilities: model.capabilities,
          ...(model.contextLength
            ? {
                model_info: {
                  "general.architecture": "testarch",
                  "testarch.context_length": model.contextLength,
                },
              }
            : {}),
        });
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as Record<string, unknown>;
        chatBodies.push(body);
        return sseChatResponse(String(body.model));
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    chatBodies,
    stop: () => server.stop(true),
  };
}

// listLocalModels also probes the other auto-detectable local endpoints
// (LM Studio, llama.cpp). Fail those probes instantly so tests never touch
// real local servers; the Ollama runtime provider uses its own fetch.
const failingDiscoveryFetch = (async () => {
  throw new Error("no local endpoint in tests");
}) as unknown as typeof fetch;

async function setupOllamaStorage(
  serverUrl: string,
  storageDirs: string[],
): Promise<string> {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
  storageDirs.push(storageDir);
  await createOrUpdateLocalProvider({
    providerType: "ollama",
    providerName: "ollama",
    apiKey: "not-needed",
    baseURL: serverUrl,
    storageDir,
  });
  return storageDir;
}

function visionUserMessage() {
  return {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "What is in this image?" },
      { type: "image" as const, data: PNG_BASE64, mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  };
}

function userContentOf(body: Record<string, unknown>): unknown[] {
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const user = messages.find((message) => message.role === "user");
  return Array.isArray(user?.content) ? user.content : [];
}

describe("LocalPiModelsRuntime + Ollama provider", () => {
  const storageDirs: string[] = [];
  const servers: FakeOllamaServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) server.stop();
    await Promise.all(
      storageDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("stored API keys resolve through the runtime's credential seam", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      providerType: "anthropic",
      providerName: "lc-anthropic",
      apiKey: "stored-key",
      storageDir,
    });
    const runtime = new LocalPiModelsRuntime({ storageDir });
    let getAuthCalls = 0;
    const originalGetAuth = runtime.getAuth.bind(runtime);
    runtime.getAuth = (providerId) => {
      getAuthCalls += 1;
      return originalGetAuth(providerId);
    };

    const resolved = await resolvePiModelForAgent(
      "anthropic/claude-opus-4-8",
      { provider_type: "anthropic" },
      { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
    );
    // API-key auth is resolved by Models.getAuth via the auth.json adapter,
    // not by a parallel factory lookup.
    expect(getAuthCalls).toBe(1);
    expect(resolved.apiKey).toBe("stored-key");
  });

  test("radius/auto lists and resolves for a configured Radius gateway", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      providerType: "radius",
      providerName: "radius",
      apiKey: "radius-key",
      storageDir,
    });
    // Radius's built-in provider fetches its gateway config with global
    // fetch; stub it for the gateway URL only.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/v1/config")) {
        return Response.json({
          baseUrl: "https://gateway.example.test/v1",
          models: [
            {
              id: "auto",
              name: "Auto",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 32000,
            },
          ],
        });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const runtime = new LocalPiModelsRuntime({
        storageDir,
        fetchImpl: failingDiscoveryFetch,
      });
      const listed = await listLocalModels(storageDir, {
        fetch: failingDiscoveryFetch,
        modelsRuntime: runtime,
      });
      expect(listed.some((model) => model.handle === "radius/auto")).toBe(true);

      // The default handle a user selects from /model must resolve for the
      // turn — the canonical refresh supplies Radius's credentialed context.
      const resolved = await resolvePiModelForAgent(
        "radius/auto",
        { provider_type: "radius" },
        { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
      );
      expect(resolved.model.id).toBe("auto");
      expect(resolved.model.provider).toBe("radius");
      expect(resolved.apiKey).toBe("radius-key");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Letta env aliases resolve inside the runtime's auth context", async () => {
    const saved = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "letta-alias-key";
    try {
      const runtime = new LocalPiModelsRuntime();
      // Upstream google only reads GEMINI_API_KEY; the runtime's AuthContext
      // maps Letta's documented alias so resolution stays inside pi-ai's
      // provider auth — no factory-side ambient fallback exists.
      const auth = await runtime.getAuth("google");
      expect(auth?.auth.apiKey).toBe("letta-alias-key");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("a runtime auth miss is not masked by a parallel factory lookup", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      providerType: "anthropic",
      providerName: "lc-anthropic",
      apiKey: "stored-direct",
      storageDir,
    });
    const runtime = new LocalPiModelsRuntime({ storageDir });
    runtime.getAuth = async () => undefined;

    const savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_OAUTH_TOKEN: process.env.ANTHROPIC_OAUTH_TOKEN,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    try {
      const resolved = await resolvePiModelForAgent(
        "anthropic/claude-opus-4-8",
        { provider_type: "anthropic" },
        { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
      );
      // The runtime is the only credential source: if it cannot resolve
      // auth, the stored key must NOT leak in through a factory-side record
      // lookup. (Ambient env is cleared above; the named env exception only
      // covers vars upstream providers do not read.)
      expect(resolved.apiKey).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("radius drops the previous account's catalog when the credential changes", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      providerType: "radius",
      providerName: "radius",
      apiKey: "key-a",
      storageDir,
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/v1/config")) {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== "Bearer key-a") {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({
          baseUrl: "https://gateway.example.test/v1",
          models: [
            {
              id: "account-a-model",
              name: "Account A",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 32000,
            },
          ],
        });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const runtime = new LocalPiModelsRuntime({
        storageDir,
        fetchImpl: failingDiscoveryFetch,
      });
      await runtime.refreshAll();
      expect(runtime.getModel("radius", "account-a-model")).toBeDefined();

      // Switching accounts: the new credential fails against the gateway,
      // and account A's catalog must not survive as "last known".
      await createOrUpdateLocalProvider({
        providerType: "radius",
        providerName: "radius",
        apiKey: "key-b",
        storageDir,
      });
      await runtime.refreshAll();
      expect(runtime.getModels("radius")).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("built-in catalog models resolve to the runtime-published instance", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
    storageDirs.push(storageDir);
    const runtime = new LocalPiModelsRuntime({ storageDir });

    const resolved = await resolvePiModelForAgent(
      "anthropic/claude-opus-4-8",
      { provider_type: "anthropic" },
      { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
    );
    // The LET-10125 target invariant holds for built-ins too: with no
    // effective overrides, the turn model IS the runtime-published instance.
    expect(resolved.model).toBe(
      runtime.getModel("anthropic", "claude-opus-4-8")!,
    );
  });

  test("/model listing and turn execution resolve the same provider-published Model", async () => {
    const server = startFakeOllama([
      {
        id: "qwen3.6:27b",
        capabilities: ["completion", "vision", "tools", "thinking"],
        contextLength: 262144,
      },
    ]);
    servers.push(server);
    const storageDir = await setupOllamaStorage(server.url, storageDirs);
    const runtime = new LocalPiModelsRuntime({ storageDir });

    const listed = await listLocalModels(storageDir, {
      fetch: failingDiscoveryFetch,
      modelsRuntime: runtime,
    });
    const entry = listed.find((model) => model.handle === "ollama/qwen3.6:27b");
    expect(entry).toBeDefined();
    expect(entry?.max_context_window).toBe(262144);

    const resolved = await resolvePiModelForAgent(
      "ollama/qwen3.6:27b",
      {},
      { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
    );
    // The turn model is the exact Model instance the provider published for
    // listing — the LET-10125 target invariant.
    expect(resolved.model).toBe(runtime.getModel("ollama", "qwen3.6:27b")!);
    expect(resolved.model.input).toEqual(["text", "image"]);
    expect(resolved.model.reasoning).toBe(true);
    expect(resolved.model.contextWindow).toBe(262144);
  });

  test("vision model with no name marker keeps base64 image_url in the request payload", async () => {
    const server = startFakeOllama([
      {
        id: "qwen3.6:27b",
        capabilities: ["completion", "vision", "tools", "thinking"],
      },
    ]);
    servers.push(server);
    const storageDir = await setupOllamaStorage(server.url, storageDirs);
    const runtime = new LocalPiModelsRuntime({ storageDir });

    const resolved = await resolvePiModelForAgent(
      "ollama/qwen3.6:27b",
      {},
      { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
    );
    const result = await runtime
      .streamSimple(
        resolved.model,
        { messages: [visionUserMessage()] },
        { apiKey: resolved.apiKey, maxRetries: 0 },
      )
      .result();
    expect(result.stopReason).toBe("stop");

    expect(server.chatBodies).toHaveLength(1);
    const content = userContentOf(server.chatBodies[0]!) as Array<{
      type: string;
      image_url?: { url: string };
      text?: string;
    }>;
    const image = content.find((part) => part.type === "image_url");
    expect(image?.image_url?.url).toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  test("non-vision model gets the explicit image omission placeholder", async () => {
    const server = startFakeOllama([
      { id: "smol-text:3b", capabilities: ["completion", "tools"] },
    ]);
    servers.push(server);
    const storageDir = await setupOllamaStorage(server.url, storageDirs);
    const runtime = new LocalPiModelsRuntime({ storageDir });

    const resolved = await resolvePiModelForAgent(
      "ollama/smol-text:3b",
      {},
      { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
    );
    expect(resolved.model.input).toEqual(["text"]);

    const result = await runtime
      .streamSimple(
        resolved.model,
        { messages: [visionUserMessage()] },
        { apiKey: resolved.apiKey, maxRetries: 0 },
      )
      .result();
    expect(result.stopReason).toBe("stop");

    const content = userContentOf(server.chatBodies[0]!) as Array<{
      type: string;
      text?: string;
    }>;
    expect(content.some((part) => part.type === "image_url")).toBe(false);
    expect(
      content.some(
        (part) =>
          part.type === "text" &&
          part.text === "(image omitted: model does not support images)",
      ),
    ).toBe(true);
  });

  test("base URL update invalidates and refreshes only the Ollama provider", async () => {
    const serverA = startFakeOllama([
      { id: "model-a:1b", capabilities: ["completion"] },
    ]);
    const serverB = startFakeOllama([
      { id: "model-b:1b", capabilities: ["completion", "vision"] },
    ]);
    servers.push(serverA, serverB);
    const storageDir = await setupOllamaStorage(serverA.url, storageDirs);
    const runtime = new LocalPiModelsRuntime({ storageDir });

    await runtime.refresh("ollama");
    expect(runtime.getModel("ollama", "model-a:1b")).toBeDefined();
    const builtinBefore = runtime.getModels("anthropic");
    expect(builtinBefore.length).toBeGreaterThan(0);

    await createOrUpdateLocalProvider({
      providerType: "ollama",
      providerName: "ollama",
      apiKey: "not-needed",
      baseURL: serverB.url,
      storageDir,
    });

    // Stale discovery from the old endpoint is dropped immediately...
    expect(runtime.getModels("ollama")).toHaveLength(0);
    // ...and a refresh repopulates from the new endpoint.
    await runtime.refresh("ollama");
    expect(runtime.getModel("ollama", "model-b:1b")?.input).toEqual([
      "text",
      "image",
    ]);
    expect(runtime.getModel("ollama", "model-a:1b")).toBeUndefined();
    // Other providers are untouched by the Ollama connection change.
    expect(runtime.getModels("anthropic")[0]).toBe(builtinBefore[0]!);
    expect(runtime.getModels("anthropic")).toHaveLength(builtinBefore.length);
  });

  test("llama.cpp models resolve through the runtime with /props capabilities", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "/models/qwen3.6-27b.gguf", object: "model" }],
          });
        }
        if (url.pathname === "/props") {
          return Response.json({
            modalities: { vision: true, audio: false },
            default_generation_settings: { n_ctx: 32768 },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push({ url: "", chatBodies: [], stop: () => server.stop(true) });
    const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      providerType: "llama_cpp",
      providerName: "llama-cpp",
      apiKey: "not-needed",
      baseURL: `http://localhost:${server.port}`,
      storageDir,
    });
    const runtime = new LocalPiModelsRuntime({ storageDir });

    const listed = await listLocalModels(storageDir, {
      fetch: failingDiscoveryFetch,
      modelsRuntime: runtime,
    });
    const entry = listed.find(
      (model) => model.handle === "llama.cpp//models/qwen3.6-27b.gguf",
    );
    expect(entry).toBeDefined();
    expect(entry?.max_context_window).toBe(32768);

    const resolved = await resolvePiModelForAgent(
      "llama.cpp//models/qwen3.6-27b.gguf",
      {},
      { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
    );
    expect(resolved.model).toBe(
      runtime.getModel("llama-cpp", "/models/qwen3.6-27b.gguf")!,
    );
    expect(resolved.model.input).toEqual(["text", "image"]);
  });

  test("refreshAll never probes unconfigured remote endpoints or mods", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-models-runtime-"));
    storageDirs.push(storageDir);
    const requested: string[] = [];
    const recordingFetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      throw new Error("no endpoint in tests");
    }) as unknown as typeof fetch;
    const runtime = new LocalPiModelsRuntime({
      storageDir,
      fetchImpl: recordingFetch,
    });

    await runtime.refreshAll();

    // Auto-detectable local daemons may be probed; the remote Ollama Cloud
    // endpoint must not be touched without a configured record/env key.
    expect(requested.some((url) => url.includes("ollama.com"))).toBe(false);
  });

  test("endpoint change drops the stored catalog instead of restoring stale models", async () => {
    const serverA = startFakeOllama([
      { id: "model-a:1b", capabilities: ["completion"] },
    ]);
    servers.push(serverA);
    const storageDir = await setupOllamaStorage(serverA.url, storageDirs);
    const runtime = new LocalPiModelsRuntime({ storageDir });

    await runtime.refresh("ollama");
    expect(runtime.getModel("ollama", "model-a:1b")).toBeDefined();

    // Reconfigure to an endpoint that is offline: the old endpoint's catalog
    // must not be restored from the models store by the failed refresh.
    const serverB = startFakeOllama([]);
    const deadUrl = serverB.url;
    serverB.stop();
    await createOrUpdateLocalProvider({
      providerType: "ollama",
      providerName: "ollama",
      apiKey: "not-needed",
      baseURL: deadUrl,
      storageDir,
    });

    expect(runtime.getModels("ollama")).toHaveLength(0);
    await expect(runtime.refresh("ollama")).rejects.toThrow();
    expect(runtime.getModels("ollama")).toHaveLength(0);
  });

  test("refresh failure retains last-known models and turns still resolve", async () => {
    const server = startFakeOllama([
      {
        id: "qwen3.6:27b",
        capabilities: ["completion", "vision", "tools", "thinking"],
      },
    ]);
    servers.push(server);
    const storageDir = await setupOllamaStorage(server.url, storageDirs);
    const runtime = new LocalPiModelsRuntime({ storageDir });

    await runtime.refresh("ollama");
    server.stop();

    await expect(runtime.refresh("ollama")).rejects.toThrow();
    // /model keeps the last-known list rather than dropping the provider.
    const listed = await listLocalModels(storageDir, {
      fetch: failingDiscoveryFetch,
      modelsRuntime: runtime,
    });
    expect(listed.some((model) => model.handle === "ollama/qwen3.6:27b")).toBe(
      true,
    );
    // Turn resolution still finds the model without a live endpoint.
    const resolved = await resolvePiModelForAgent(
      "ollama/qwen3.6:27b",
      {},
      { localProviderAuthStorageDir: storageDir, modelsRuntime: runtime },
    );
    expect(resolved.model.input).toEqual(["text", "image"]);
  });
});
