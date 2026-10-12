import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthResult } from "@earendil-works/pi-ai";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { listLocalModels } from "@/backend/local/local-model-config";
import {
  createOrUpdateLocalProvider,
  getLocalProviderApiKeyByName,
} from "@/backend/local/local-provider-auth-store";
import { OpenRouterAccountModels } from "@/backend/local/openrouter-user-models";

const OPENROUTER_ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"];
const DEFAULT_OPENROUTER_HANDLE = "openrouter/moonshotai/kimi-k2.6";

interface RecordedRequest {
  url: string;
  headers: Headers;
}

function userModelsFetch(
  respond: (url: string) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.endsWith("/models/user")) {
      return new Response("not found", { status: 404 });
    }
    requests.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function allowedIds(ids: readonly string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    headers: { "content-type": "application/json" },
  });
}

function openRouterHandles(models: readonly { handle: string }[]): string[] {
  return models
    .map((model) => model.handle)
    .filter((handle) => handle.startsWith("openrouter/"));
}

describe("OpenRouter account model filter", () => {
  let storageDir: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of OPENROUTER_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    storageDir = await mkdtemp(join(tmpdir(), "local-openrouter-user-"));
  });

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(storageDir, { recursive: true, force: true });
  });

  async function connectOpenRouter(baseURL?: string): Promise<void> {
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openrouter",
      providerName: "lc-openrouter",
      apiKey: "sk-or-test",
      ...(baseURL ? { baseURL } : {}),
    });
  }

  test("keeps only the catalog handles the account allows", async () => {
    await connectOpenRouter();
    const { fetch, requests } = userModelsFetch(() =>
      allowedIds([
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-5",
        // Allowed but not in the static catalog: not added (out of scope).
        "acme/not-in-catalog",
      ]),
    );

    const models = await listLocalModels(storageDir, { fetch });

    expect(openRouterHandles(models).sort()).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/openai/gpt-5",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/models/user");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(requests[0]?.headers.get("http-referer")).toBe("https://letta.com");
    expect(requests[0]?.headers.get("x-openrouter-title")).toBe("Letta Code");
  });

  test("leaves other providers' handles untouched", async () => {
    await connectOpenRouter();
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "opencode",
      providerName: "opencode",
      apiKey: "test-key",
    });
    const unfiltered = await listLocalModels(storageDir, {
      fetch: userModelsFetch(() => new Response("down", { status: 503 })).fetch,
    });
    const { fetch } = userModelsFetch(() =>
      allowedIds(["anthropic/claude-sonnet-4.5"]),
    );

    const filtered = await listLocalModels(storageDir, { fetch });

    const opencodeHandles = (models: readonly { handle: string }[]) =>
      models
        .map((model) => model.handle)
        .filter((handle) => handle.startsWith("opencode/"));
    expect(opencodeHandles(filtered).length).toBeGreaterThan(0);
    expect(opencodeHandles(filtered)).toEqual(opencodeHandles(unfiltered));
    expect(openRouterHandles(filtered)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
  });

  test("calls the stored regional base URL", async () => {
    await connectOpenRouter("https://eu.openrouter.ai/api/v1/");
    process.env.OPENROUTER_BASE_URL = "https://ignored.example/api/v1";
    const { fetch, requests } = userModelsFetch(() =>
      allowedIds(["anthropic/claude-sonnet-4.5"]),
    );

    await listLocalModels(storageDir, { fetch });

    expect(requests.map((request) => request.url)).toEqual([
      "https://eu.openrouter.ai/api/v1/models/user",
    ]);
  });

  test("falls back to OPENROUTER_BASE_URL when no base URL is stored", async () => {
    await connectOpenRouter();
    process.env.OPENROUTER_BASE_URL = "https://eu.openrouter.ai/api/v1";
    const { fetch, requests } = userModelsFetch(() =>
      allowedIds(["anthropic/claude-sonnet-4.5"]),
    );

    await listLocalModels(storageDir, { fetch });

    expect(requests.map((request) => request.url)).toEqual([
      "https://eu.openrouter.ai/api/v1/models/user",
    ]);
  });

  test.each([
    ["an HTTP error", () => new Response("unauthorized", { status: 401 })],
    [
      "a network error",
      () => Promise.reject(new TypeError("fetch failed")) as Promise<Response>,
    ],
    [
      "an unexpected response shape",
      () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ],
    ["an empty allow list", () => allowedIds([])],
  ])("falls back to the full static catalog on %s", async (_label, respond) => {
    await connectOpenRouter();
    const { fetch, requests } = userModelsFetch(respond);

    const models = await listLocalModels(storageDir, { fetch });

    expect(requests).toHaveLength(1);
    const handles = openRouterHandles(models);
    expect(handles[0]).toBe(DEFAULT_OPENROUTER_HANDLE);
    expect(handles).toContain("openrouter/anthropic/claude-sonnet-4.5");
    expect(handles.length).toBeGreaterThan(100);
  });

  test("drops a default the account does not allow and leads with the first allowed model", async () => {
    await connectOpenRouter();
    const { fetch } = userModelsFetch(() =>
      allowedIds(["openai/gpt-5", "anthropic/claude-sonnet-4.5"]),
    );

    const handles = openRouterHandles(
      await listLocalModels(storageDir, { fetch }),
    );

    expect(handles).not.toContain(DEFAULT_OPENROUTER_HANDLE);
    // Catalog order decides the replacement, not the response order.
    expect(handles).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/openai/gpt-5",
    ]);
  });

  test("keeps an allowed default first", async () => {
    await connectOpenRouter();
    const { fetch } = userModelsFetch(() =>
      allowedIds(["openai/gpt-5", "moonshotai/kimi-k2.6"]),
    );

    const handles = openRouterHandles(
      await listLocalModels(storageDir, { fetch }),
    );

    expect(handles).toEqual([
      DEFAULT_OPENROUTER_HANDLE,
      "openrouter/openai/gpt-5",
    ]);
  });

  test("does not call OpenRouter when no OpenRouter provider is connected", async () => {
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "opencode",
      providerName: "opencode",
      apiKey: "test-key",
    });
    const { fetch, requests } = userModelsFetch(() => allowedIds([]));

    await listLocalModels(storageDir, { fetch });

    expect(requests).toHaveLength(0);
  });
});

describe("OpenRouter account model cache", () => {
  let storageDir: string;
  const savedEnv = new Map<string, string | undefined>();
  let respond: () => Response | Promise<Response>;
  let requests: RecordedRequest[];
  let runtime: LocalPiModelsRuntime;

  beforeEach(async () => {
    for (const key of OPENROUTER_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    storageDir = await mkdtemp(join(tmpdir(), "local-openrouter-cache-"));
    respond = () => allowedIds(["anthropic/claude-sonnet-4.5"]);
    const recorder = userModelsFetch(() => respond());
    requests = recorder.requests;
    runtime = new LocalPiModelsRuntime({
      storageDir,
      fetchImpl: recorder.fetch,
    });
    await connectOpenRouter("sk-or-first");
  });

  afterEach(async () => {
    clearRegisteredPiProviders();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(storageDir, { recursive: true, force: true });
  });

  async function connectOpenRouter(apiKey: string): Promise<void> {
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openrouter",
      providerName: "lc-openrouter",
      apiKey,
    });
  }

  async function listedOpenRouterHandles(): Promise<string[]> {
    return openRouterHandles(
      await listLocalModels(storageDir, { modelsRuntime: runtime }),
    );
  }

  test("reuses the account list across listings on one runtime", async () => {
    const lists = [
      await listedOpenRouterHandles(),
      await listedOpenRouterHandles(),
      await listedOpenRouterHandles(),
    ];

    expect(requests).toHaveLength(1);
    for (const handles of lists) {
      expect(handles).toEqual(["openrouter/anthropic/claude-sonnet-4.5"]);
    }
  });

  test("uses the runtime's fetch for the account list", async () => {
    await listedOpenRouterHandles();

    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/models/user",
    ]);
  });

  test("refetches once the list is marked stale", async () => {
    await listedOpenRouterHandles();
    respond = () => allowedIds(["openai/gpt-5"]);

    runtime.markAccountModelsStale();
    const handles = await listedOpenRouterHandles();

    expect(requests).toHaveLength(2);
    expect(handles).toEqual(["openrouter/openai/gpt-5"]);
  });

  test("keeps the last good list when a refetch fails", async () => {
    await listedOpenRouterHandles();
    respond = () => new Response("down", { status: 503 });

    runtime.markAccountModelsStale();
    const handles = await listedOpenRouterHandles();

    expect(requests).toHaveLength(2);
    expect(handles).toEqual(["openrouter/anthropic/claude-sonnet-4.5"]);
  });

  test("does not retry a failed fetch on every listing", async () => {
    respond = () => new Response("down", { status: 503 });

    const first = await listedOpenRouterHandles();
    const second = await listedOpenRouterHandles();

    expect(requests).toHaveLength(1);
    expect(first).toContain(DEFAULT_OPENROUTER_HANDLE);
    expect(second).toEqual(first);
  });

  test("never applies one key's list to another key", async () => {
    await listedOpenRouterHandles();
    await connectOpenRouter("sk-or-second");
    respond = () => new Response("unauthorized", { status: 401 });

    const handles = await listedOpenRouterHandles();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("authorization")).toBe(
      "Bearer sk-or-second",
    );
    expect(handles).toContain(DEFAULT_OPENROUTER_HANDLE);
    expect(handles.length).toBeGreaterThan(100);
  });

  test("leaves a mod that owns the openrouter id alone", async () => {
    registerPiProvider("openrouter", {
      baseUrl: "http://127.0.0.1:9/api/v1",
      apiKey: "not-needed",
      api: "openai-completions",
      models: [
        {
          id: "proxy-model",
          name: "Proxy Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 4096,
        },
      ],
    });

    const handles = await listedOpenRouterHandles();

    expect(requests).toHaveLength(0);
    expect(handles).toContain("openrouter/proxy-model");
  });
});

describe("OpenRouter connection resolution", () => {
  let storageDir: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of OPENROUTER_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    storageDir = await mkdtemp(join(tmpdir(), "local-openrouter-conn-"));
    await connectOpenRouter("sk-or-first");
  });

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(storageDir, { recursive: true, force: true });
  });

  async function connectOpenRouter(
    apiKey: string,
    baseURL?: string,
  ): Promise<void> {
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openrouter",
      providerName: "lc-openrouter",
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  /** Reads the stored key, lets `overlap` write, then returns the read key. */
  function overlappingGetAuth(
    overlap: (call: number) => Promise<void>,
  ): () => Promise<AuthResult | undefined> {
    let calls = 0;
    return async () => {
      const apiKey = getLocalProviderApiKeyByName("lc-openrouter", storageDir);
      await overlap(calls++);
      return apiKey ? { auth: { apiKey } } : undefined;
    };
  }

  test("never sends one connection's key to another connection's endpoint", async () => {
    const { fetch, requests } = userModelsFetch(() =>
      allowedIds(["anthropic/claude-sonnet-4.5"]),
    );
    const accountModels = new OpenRouterAccountModels({
      storageDir,
      fetchImpl: fetch,
      getAuth: overlappingGetAuth(async (call) => {
        if (call === 0) {
          await connectOpenRouter(
            "sk-or-second",
            "https://eu.openrouter.ai/api/v1",
          );
        }
      }),
    });

    await accountModels.allowedModelIds();

    expect(
      requests.map((request) => [
        request.url,
        request.headers.get("authorization"),
      ]),
    ).toEqual([
      ["https://eu.openrouter.ai/api/v1/models/user", "Bearer sk-or-second"],
    ]);
  });

  test("sends nothing while the connection keeps changing", async () => {
    const { fetch, requests } = userModelsFetch(() =>
      allowedIds(["anthropic/claude-sonnet-4.5"]),
    );
    const accountModels = new OpenRouterAccountModels({
      storageDir,
      fetchImpl: fetch,
      getAuth: overlappingGetAuth((call) =>
        connectOpenRouter(
          `sk-or-${call + 2}`,
          `https://region-${call}.openrouter.ai/api/v1`,
        ),
      ),
    });

    const allowed = await accountModels.allowedModelIds();

    expect(allowed).toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
