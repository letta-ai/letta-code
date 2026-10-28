import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  listCursorModels,
  runCursorTurn,
  sendCursorMessage,
} from "./cursor-session";
import {
  formatExternalCodingAgentId,
  parseExternalCodingAgentId,
} from "./external-coding-agent";

const options = {
  parentAgentId: "agent-cursor-test",
  cwd: tmpdir(),
  prompt: "Do not run",
};

test("Cursor sessions round-trip through local and computer-qualified handles", () => {
  const id = randomUUID();
  for (const computer of [undefined, "office-mac"]) {
    const handle = formatExternalCodingAgentId("cursor", id, computer);
    expect(parseExternalCodingAgentId(handle)).toEqual({
      type: "cursor",
      sessionId: id,
      ...(computer ? { computer } : {}),
    });
  }
  expect(parseExternalCodingAgentId("cursor_../../other-session")).toBeNull();
  expect(parseExternalCodingAgentId(`cursor_${id}@`)).toBeNull();
});

test("Cursor fails before spawning when credentials or a first-turn model are absent", async () => {
  const missingKey = await runCursorTurn(
    { ...options, model: "composer-2.5" },
    {},
  );
  expect(missingKey.success).toBe(false);
  expect(missingKey.error).toContain("CURSOR_API_KEY");
  const missingModel = await runCursorTurn(options, {
    CURSOR_API_KEY: "test-not-a-key",
  });
  expect(missingModel.success).toBe(false);
  expect(missingModel.error).toContain("explicit model");
  expect(missingModel.error).not.toContain("test-not-a-key");
});

test("Cursor rejects cancelled work and unsafe persisted-session paths", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runCursorTurn(
    { ...options, signal: controller.signal },
    {},
  );
  expect(cancelled.success).toBe(false);
  expect(cancelled.error).toMatch(/aborted/i);
  const invalid = await runCursorTurn(
    { ...options, resumeSessionId: "../escape" },
    {},
  );
  expect(invalid.success).toBe(false);
  expect(invalid.error).toContain("Invalid Cursor session");
  await expect(
    sendCursorMessage({ ...options, sessionId: "../escape" }, {}),
  ).rejects.toThrow("Invalid Cursor session");
});

// Real worker process and SDK against a local stand-in for the Cursor API.
async function withCursorApi<T>(
  respond: (path: string) => Response,
  body: (env: NodeJS.ProcessEnv, paths: string[]) => Promise<T>,
): Promise<T> {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return respond(path);
    },
  });
  try {
    return await body(
      {
        ...process.env,
        CURSOR_API_KEY: "test-not-a-key",
        CURSOR_BACKEND_URL: `http://127.0.0.1:${server.port}`,
      },
      paths,
    );
  } finally {
    server.stop(true);
  }
}

test("Cursor model discovery returns the SDK catalog without starting an agent", async () => {
  const item = {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer"],
  };
  await withCursorApi(
    () => Response.json({ items: [item] }),
    async (env, paths) => {
      expect(await listCursorModels(tmpdir(), env)).toEqual([item]);
      expect(paths).toContain("/v1/models");
      expect(paths.some((path) => path.includes("agent"))).toBe(false);
    },
  );
}, 30_000);

test("Cursor model discovery fails closed on missing keys, API errors, and bad catalogs", async () => {
  await expect(listCursorModels(tmpdir(), {})).rejects.toThrow(
    "CURSOR_API_KEY",
  );
  await withCursorApi(
    () => Response.json({ error: "Invalid User API Key" }, { status: 401 }),
    async (env) => {
      await expect(listCursorModels(tmpdir(), env)).rejects.toThrow();
    },
  );
  await withCursorApi(
    () => Response.json({}),
    async (env) => {
      await expect(listCursorModels(tmpdir(), env)).rejects.toThrow(
        "Cursor did not return a model catalog",
      );
    },
  );
}, 60_000);
