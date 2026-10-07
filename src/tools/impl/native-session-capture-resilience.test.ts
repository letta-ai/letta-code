import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitNativeSessionCaptureDrainForTests,
  clearNativeSessionCaptureForTests,
  rememberNativeSession,
  reserveNativeSessionCapture,
  setNativeSessionCaptureSealHookForTests,
} from "./native-session-capture";

const ID = "11111111-1111-4111-8111-111111111111";
const scope = {
  agentId: "agent-parent",
  conversationId: "conv-parent",
  actingUserId: "user-parent",
};
let directory: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  await clearNativeSessionCaptureForTests();
});

async function fixture(bytes: Buffer) {
  directory = await mkdtemp(join(tmpdir(), "native-session-capture-"));
  const nativeDir = join(directory, ".codex", "sessions", "2026", "09", "27");
  await mkdir(nativeDir, { recursive: true });
  const path = join(nativeDir, `rollout-2026-09-27T01-01-01-${ID}.jsonl`);
  await writeFile(path, bytes);
  return { path, env: { HOME: directory } };
}

async function endpoint(
  calls: Array<{
    url: string;
    body: Record<string, unknown>;
    actingUser: string | undefined;
  }>,
  fail: ((requestNumber: number) => boolean | number) | false = false,
) {
  server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<
      string,
      unknown
    >;
    calls.push({
      url: request.url ?? "",
      body,
      actingUser: request.headers["x-letta-acting-user-id"] as
        | string
        | undefined,
    });
    const failure = typeof fail === "function" ? fail(calls.length) : fail;
    if (failure) {
      response
        .writeHead(typeof failure === "number" ? failure : 503)
        .end('{"error":"unavailable"}');
      return;
    }
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        chunk_index: body.chunk_index,
        accepted_bytes: Buffer.from(String(body.data_base64), "base64").length,
      }),
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("native CLI JSONL capture resilience", () => {
  test("terminal seal failure resets at EOF before capturing the next actor", async () => {
    const { path, env } = await fixture(Buffer.from("actor-a\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls);
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    let attempts = 0;
    setNativeSessionCaptureSealHookForTests(async () => {
      attempts += 1;
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    const actorA = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-a" },
      env,
      options,
    );
    await expect(actorA.capture()).rejects.toThrow("permission denied");
    expect(attempts).toBe(1);

    setNativeSessionCaptureSealHookForTests(undefined);
    const actorB = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-b" },
      env,
      options,
    );
    await appendFile(path, "actor-b\n");
    await expect(actorB.capture()).resolves.toBeUndefined();
    await expect(
      awaitNativeSessionCaptureDrainForTests("codex", ID),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.actingUser).toBe("actor-b");
    expect(
      Buffer.from(String(calls[0]?.body.data_base64), "base64").toString(),
    ).toBe("actor-b\n");
  });

  test("failed boundary reset serializes concurrent successors and rediscovers a relocated file", async () => {
    const { path, env } = await fixture(Buffer.from("actor-a\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls);
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    const actorA = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-a" },
      env,
      options,
    );
    await rm(path);
    await expect(actorA.capture()).rejects.toThrow();

    if (!directory) throw new Error("missing fixture directory");
    const relocated = join(
      directory,
      ".codex",
      "sessions",
      "2026",
      "09",
      "27",
      `rollout-2026-09-27T02-02-02-${ID}.jsonl`,
    );
    await writeFile(relocated, "dropped-a\n");
    const actorBPromise = reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-b" },
      env,
      options,
    );
    const actorCPromise = reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-c" },
      env,
      options,
    );
    const actorB = await actorBPromise;
    let actorCResolved = false;
    void actorCPromise.then(() => {
      actorCResolved = true;
    });
    await Bun.sleep(10);
    expect(actorCResolved).toBe(false);
    await appendFile(relocated, "actor-b\n");
    await actorB.capture();
    const actorC = await actorCPromise;
    await appendFile(relocated, "actor-c\n");
    await actorC.capture();
    await awaitNativeSessionCaptureDrainForTests("codex", ID);
    expect(
      calls.map((call) => ({
        actor: call.actingUser,
        data: Buffer.from(String(call.body.data_base64), "base64").toString(),
      })),
    ).toEqual([
      { actor: "actor-b", data: "actor-b\n" },
      { actor: "actor-c", data: "actor-c\n" },
    ]);
  });

  test("seal retirement preserves retryable segments from an earlier actor", async () => {
    const { path, env } = await fixture(Buffer.from("actor-a\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(
      calls,
      (requestNumber) => requestNumber === 1 && 503,
    );
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    const actorA = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-a" },
      env,
      options,
    );
    await actorA.capture();
    const actorB = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-b" },
      env,
      options,
    );
    await writeFile(path, "b\n");
    await expect(actorB.capture()).rejects.toThrow("truncated before capture");
    const actorC = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-c" },
      env,
      options,
    );
    await appendFile(path, "actor-c\n");
    await actorC.capture();
    await awaitNativeSessionCaptureDrainForTests("codex", ID);
    expect(
      calls.map((call) => ({
        actor: call.actingUser,
        data: Buffer.from(String(call.body.data_base64), "base64").toString(),
      })),
    ).toEqual([
      { actor: "actor-a", data: "actor-a\n" },
      { actor: "actor-a", data: "actor-a\n" },
      { actor: "actor-c", data: "actor-c\n" },
    ]);
  });
});
