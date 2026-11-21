import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "@/agent/available-models";
import { __testSetBackend } from "@/backend";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { LocalBackend } from "@/backend/local/local-backend";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";

/**
 * The OpenRouter account list (`/models/user`) is cached by the backend's
 * models runtime. The availability cache decides freshness: its cached reads
 * and direct `backend.listModels()` callers reuse the runtime list, while a
 * `force` refresh or a provider mutation (which clears the cache) refetches.
 */

let allowed: string[] = [];
let userModelRequests = 0;

const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.endsWith("/models/user")) {
    return new Response("not found", { status: 404 });
  }
  userModelRequests++;
  return new Response(JSON.stringify({ data: allowed.map((id) => ({ id })) }), {
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

function openRouterHandles(handles: Iterable<string>): string[] {
  return [...handles].filter((handle) => handle.startsWith("openrouter/"));
}

describe("OpenRouter account filter caching", () => {
  const savedEnv = new Map<string, string | undefined>();
  let storageDir: string;
  let backend: LocalBackend;

  beforeEach(async () => {
    for (const key of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    storageDir = await mkdtemp(join(tmpdir(), "available-openrouter-"));
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openrouter",
      providerName: "lc-openrouter",
      apiKey: "sk-or-test",
    });
    allowed = ["anthropic/claude-sonnet-4.5"];
    userModelRequests = 0;
    clearAvailableModelsCache();
    backend = new LocalBackend({
      storageDir,
      modelsRuntime: new LocalPiModelsRuntime({ storageDir, fetchImpl }),
    });
    __testSetBackend(backend);
  });

  afterEach(async () => {
    clearAvailableModelsCache();
    __testSetBackend(null);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(storageDir, { recursive: true, force: true });
  });

  test("cached reads and direct listings reuse the list; force refetches", async () => {
    const first = await getAvailableModelHandles();
    expect(openRouterHandles(first.handles)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
    expect(userModelRequests).toBe(1);

    allowed = ["anthropic/claude-sonnet-4.5", "openai/gpt-5"];
    const cached = await getAvailableModelHandles();
    expect(cached.source).toBe("cache");
    // Startup, default-model and conversation-switch paths list directly.
    const direct = (await backend.listModels()) as { handle?: string }[];
    expect(
      openRouterHandles(direct.map((model) => model.handle ?? "")),
    ).toEqual(["openrouter/anthropic/claude-sonnet-4.5"]);
    expect(userModelRequests).toBe(1);

    const forced = await getAvailableModelHandles({ forceRefresh: true });
    expect(forced.source).toBe("network");
    expect(userModelRequests).toBe(2);
    expect(openRouterHandles(forced.handles)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/openai/gpt-5",
    ]);
  });

  test("a provider mutation refetches the account list", async () => {
    await getAvailableModelHandles();
    expect(userModelRequests).toBe(1);

    // connect/update/disconnect handlers clear the availability cache.
    allowed = ["openai/gpt-5"];
    clearAvailableModelsCache();
    const after = await getAvailableModelHandles();

    expect(userModelRequests).toBe(2);
    expect(openRouterHandles(after.handles)).toEqual([
      "openrouter/openai/gpt-5",
    ]);
  });
});
