import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { models } from "@/agent/model-catalog";
import {
  __testResetRemoteModelCatalog,
  applyCatalogModels,
  loadPersistedModelCatalog,
  refreshModelCatalog,
  toCatalogModel,
} from "@/agent/remote-model-catalog";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { settingsManager } from "@/settings-manager";

await settingsManager.initialize();

/**
 * Remote catalog refresh semantics (LET-9792).
 *
 * The bundled models.json snapshot must survive every failure mode: non-API
 * backends, HTTP errors, malformed payloads, and payloads that fail the
 * sanity gate (empty / no default entry). Only a valid payload may replace
 * the live catalog contents — in place, so existing `models` imports see it.
 */

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.LETTA_BASE_URL;
const originalApiKey = process.env.LETTA_API_KEY;
const snapshot = models.map((model) => ({ ...model }));

function restoreSnapshot() {
  models.splice(0, models.length, ...snapshot.map((model) => ({ ...model })));
}

function remoteEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "auto",
    handle: "letta/auto",
    label: "Auto",
    brand: "letta",
    maxContextWindow: 140000,
    isDefault: true,
    free: true,
    contextWindow: 140000,
    maxOutputTokens: 28000,
    config: { parallel_tool_calls: true },
    ...overrides,
  };
}

function mockCatalogResponse(body: unknown, status = 200) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
}

let cacheDir: string;

beforeEach(() => {
  __testResetRemoteModelCatalog();
  setConfiguredBackendMode("api");
  process.env.LETTA_BASE_URL = "http://localhost:9999";
  process.env.LETTA_API_KEY = "test-key";
  cacheDir = mkdtempSync(join(tmpdir(), "lc-model-catalog-test-"));
  process.env.LETTA_MODEL_CATALOG_CACHE_DIR = cacheDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreSnapshot();
  setConfiguredBackendMode("api");
  delete process.env.LETTA_MODEL_CATALOG_CACHE_DIR;
  rmSync(cacheDir, { recursive: true, force: true });
  if (originalBaseUrl === undefined) {
    delete process.env.LETTA_BASE_URL;
  } else {
    process.env.LETTA_BASE_URL = originalBaseUrl;
  }
  if (originalApiKey === undefined) {
    delete process.env.LETTA_API_KEY;
  } else {
    process.env.LETTA_API_KEY = originalApiKey;
  }
});

describe("toCatalogModel", () => {
  test("recombines typed fields and config into updateArgs", () => {
    const mapped = toCatalogModel({
      id: "opus",
      handle: "anthropic/claude-opus-4-8",
      label: "Opus 4.8",
      brand: "anthropic",
      maxContextWindow: 950000,
      description: "Opus 4.8 (high reasoning)",
      isFeatured: true,
      contextWindow: 200000,
      maxOutputTokens: 128000,
      config: { reasoning_effort: "high", enable_reasoner: true },
    });

    expect(mapped).toEqual({
      id: "opus",
      handle: "anthropic/claude-opus-4-8",
      label: "Opus 4.8",
      description: "Opus 4.8 (high reasoning)",
      isFeatured: true,
      updateArgs: {
        reasoning_effort: "high",
        enable_reasoner: true,
        context_window: 200000,
        max_output_tokens: 128000,
      },
    });
  });

  test("omits absent optional fields instead of emitting false/undefined", () => {
    const mapped = toCatalogModel({
      id: "bare",
      handle: "openai/some-model",
      label: "Some Model",
      brand: "openai",
      maxContextWindow: 100000,
    });

    expect(mapped).toEqual({
      id: "bare",
      handle: "openai/some-model",
      label: "Some Model",
      description: "",
    });
    expect("isFeatured" in mapped).toBe(false);
    expect("updateArgs" in mapped).toBe(false);
  });
});

describe("applyCatalogModels", () => {
  test("rejects empty payloads", () => {
    expect(applyCatalogModels([])).toBe(false);
    expect(models.length).toBeGreaterThan(0);
  });

  test("rejects payloads without a default/auto entry", () => {
    const before = models.length;
    const applied = applyCatalogModels([
      {
        id: "opus",
        handle: "anthropic/claude-opus-4-8",
        label: "Opus 4.8",
        description: "",
      },
    ]);

    expect(applied).toBe(false);
    expect(models.length).toBe(before);
  });

  test("replaces catalog contents in place", () => {
    const reference = models; // simulate an existing import-time capture
    const applied = applyCatalogModels([
      {
        id: "auto",
        handle: "letta/auto",
        label: "Auto",
        description: "",
        isDefault: true,
      },
      {
        id: "new-model",
        handle: "openai/gpt-9",
        label: "GPT-9",
        description: "",
      },
    ]);

    expect(applied).toBe(true);
    expect(reference.length).toBe(2);
    expect(reference.find((m) => m.id === "new-model")?.handle).toBe(
      "openai/gpt-9",
    );
  });
});

describe("refreshModelCatalog", () => {
  test("no-ops on the local backend", async () => {
    setConfiguredBackendMode("local");
    const fetchMock = mock(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await refreshModelCatalog({ force: true })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("applies a valid remote catalog", async () => {
    mockCatalogResponse({
      models: [
        remoteEntry(),
        remoteEntry({
          id: "fresh-model",
          handle: "openai/gpt-9",
          label: "GPT-9",
          isDefault: false,
          free: false,
        }),
      ],
    });

    expect(await refreshModelCatalog({ force: true })).toBe(true);
    expect(models.length).toBe(2);
    expect(models.find((m) => m.id === "fresh-model")?.label).toBe("GPT-9");
  });

  test("keeps the current catalog on HTTP errors", async () => {
    const before = models.length;
    mockCatalogResponse({ error: "Unauthorized" }, 401);

    expect(await refreshModelCatalog({ force: true })).toBe(false);
    expect(models.length).toBe(before);
  });

  test("rejects the entire payload when any row is invalid", async () => {
    const before = models.length;
    mockCatalogResponse({
      models: [remoteEntry(), { handle: 42 }],
    });

    expect(await refreshModelCatalog({ force: true })).toBe(false);
    expect(models.length).toBe(before);
    expect(models[0]?.id).toBe("auto");
  });

  test("rejects rows with invalid required mapping metadata", async () => {
    const before = models.length;
    mockCatalogResponse({
      models: [
        remoteEntry({
          brand: 42,
          maxContextWindow: "unbounded",
        }),
      ],
    });

    expect(await refreshModelCatalog({ force: true })).toBe(false);
    expect(models.length).toBe(before);
  });

  test("keeps the current catalog on network failure", async () => {
    const before = models.length;
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network down")),
    ) as unknown as typeof fetch;

    expect(await refreshModelCatalog({ force: true })).toBe(false);
    expect(models.length).toBe(before);
  });

  test("persists successful refreshes and reloads them from disk", async () => {
    mockCatalogResponse({
      models: [
        remoteEntry(),
        remoteEntry({
          id: "persisted-model",
          handle: "openai/gpt-9",
          label: "GPT-9",
          isDefault: false,
          free: false,
        }),
      ],
    });
    expect(await refreshModelCatalog({ force: true })).toBe(true);

    restoreSnapshot(); // simulate a fresh process with only the bundled snapshot
    expect(models.find((m) => m.id === "persisted-model")).toBeUndefined();

    expect(loadPersistedModelCatalog("http://localhost:9999")).toBe(true);
    expect(models.find((m) => m.id === "persisted-model")?.label).toBe("GPT-9");
  });

  test("does not load a cache written for another API server", async () => {
    mockCatalogResponse({
      models: [
        remoteEntry(),
        remoteEntry({
          id: "server-a-model",
          handle: "openai/server-a-model",
          label: "Server A",
          isDefault: false,
          free: false,
        }),
      ],
    });
    expect(await refreshModelCatalog({ force: true })).toBe(true);

    restoreSnapshot();
    expect(loadPersistedModelCatalog("http://localhost:9998")).toBe(false);
    expect(models.some((model) => model.id === "server-a-model")).toBe(false);
  });

  test("does not carry a live or persisted catalog across API servers", async () => {
    mockCatalogResponse({
      models: [
        remoteEntry(),
        remoteEntry({
          id: "server-a-model",
          handle: "openai/server-a-model",
          label: "Server A",
          isDefault: false,
          free: false,
        }),
      ],
    });
    expect(await refreshModelCatalog({ force: true })).toBe(true);
    expect(models.some((model) => model.id === "server-a-model")).toBe(true);

    process.env.LETTA_BASE_URL = "http://localhost:9998";
    mockCatalogResponse({ error: "Not Found" }, 404);

    expect(await refreshModelCatalog({ force: true })).toBe(false);
    expect(models.some((model) => model.id === "server-a-model")).toBe(false);
    expect(models.length).toBe(snapshot.length);
  });

  test("does not let an old server's late response overwrite the active catalog", async () => {
    let releaseServerA!: (response: Response) => void;
    let markServerAStarted!: () => void;
    const serverAResponse = new Promise<Response>((resolve) => {
      releaseServerA = resolve;
    });
    const serverAStarted = new Promise<void>((resolve) => {
      markServerAStarted = resolve;
    });
    globalThis.fetch = mock((input: Parameters<typeof fetch>[0]) => {
      if (String(input).startsWith("http://localhost:9999/")) {
        markServerAStarted();
        return serverAResponse;
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              remoteEntry(),
              remoteEntry({
                id: "server-b-model",
                handle: "openai/server-b-model",
                label: "Server B",
                isDefault: false,
                free: false,
              }),
            ],
          }),
        ),
      );
    }) as unknown as typeof fetch;

    const serverARefresh = refreshModelCatalog({ force: true });
    await serverAStarted;
    process.env.LETTA_BASE_URL = "http://localhost:9998";
    expect(await refreshModelCatalog({ force: true })).toBe(true);

    releaseServerA(
      new Response(
        JSON.stringify({
          models: [
            remoteEntry(),
            remoteEntry({
              id: "server-a-model",
              handle: "openai/server-a-model",
              label: "Server A",
              isDefault: false,
              free: false,
            }),
          ],
        }),
      ),
    );
    expect(await serverARefresh).toBe(false);
    expect(models.some((model) => model.id === "server-a-model")).toBe(false);
    expect(models.some((model) => model.id === "server-b-model")).toBe(true);
  });

  test("attaches a timeout signal to the catalog request", async () => {
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = mock(
      (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        requestSignal = init?.signal;
        return Promise.reject(new Error("network down"));
      },
    ) as unknown as typeof fetch;

    expect(await refreshModelCatalog({ force: true })).toBe(false);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
  });

  test("throttles by TTL unless forced", async () => {
    mockCatalogResponse({ models: [remoteEntry()] });
    expect(await refreshModelCatalog({ force: true })).toBe(true);

    const fetchMock = mock(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await refreshModelCatalog()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
