import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureNativeSession,
  clearNativeSessionCaptureForTests,
  findNativeSessionPath,
  rememberNativeSession,
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
  clearNativeSessionCaptureForTests();
});

async function fixture(source: "claude_code" | "codex", bytes: Buffer) {
  directory = await mkdtemp(join(tmpdir(), "native-session-capture-"));
  const nativeDir =
    source === "claude_code"
      ? join(directory, ".claude", "projects", "-repo")
      : join(directory, ".codex", "sessions", "2026", "09", "27");
  await mkdir(nativeDir, { recursive: true });
  const path = join(
    nativeDir,
    source === "claude_code"
      ? `${ID}.jsonl`
      : `rollout-2026-09-27T01-01-01-${ID}.jsonl`,
  );
  await writeFile(path, bytes);
  return { path, env: { HOME: directory } };
}

async function endpoint(
  calls: Array<{
    url: string;
    body: Record<string, unknown>;
    actingUser: string | undefined;
  }>,
  fail = false,
  beforeResponse?: (requestNumber: number) => Promise<void>,
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
    await beforeResponse?.(calls.length);
    if (fail) {
      response.writeHead(503).end('{"error":"unavailable"}');
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

describe("native CLI JSONL capture", () => {
  test("captures an append while the prior chunk is still uploading", async () => {
    const { path, env } = await fixture("codex", Buffer.from("first\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    let firstReceived!: () => void;
    let releaseFirst!: () => void;
    const received = new Promise<void>((resolve) => {
      firstReceived = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const url = await endpoint(calls, false, async (number) => {
      if (number === 1) {
        firstReceived();
        await release;
      }
    });
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    const first = captureNativeSession("codex", ID, scope, env, options);
    await received;
    await appendFile(path, "second\n");
    const second = captureNativeSession("codex", ID, scope, env, options);
    releaseFirst();
    await Promise.all([first, second]);
    expect(
      calls.map(({ body }) =>
        Buffer.from(String(body.data_base64), "base64").toString(),
      ),
    ).toEqual(["first\n", "second\n"]);
  });

  test.each(["claude_code", "codex"] as const)(
    "uploads exact %s bytes, then only resumed append",
    async (source) => {
      const initial = Buffer.from('{"text":"𝄞"}\n{"x":1}\n');
      const { path, env } = await fixture(source, initial);
      expect(await findNativeSessionPath(source, ID, env)).toBe(path);
      const calls: Array<{
        url: string;
        body: Record<string, unknown>;
        actingUser: string | undefined;
      }> = [];
      const url = await endpoint(calls);
      rememberNativeSession(source, ID, scope, "https://api.letta.com");
      await captureNativeSession(source, ID, scope, env, {
        baseUrl: url,
        apiKey: "test",
        cloudUrl: "https://api.letta.com",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain(
        `/v1/conversations/${scope.conversationId}/native-session/chunks`,
      );
      expect(calls[0]?.actingUser).toBe(scope.actingUserId);
      expect(calls[0]?.body).toMatchObject({
        agent_id: scope.agentId,
        source,
        session_id: ID,
        chunk_index: 0,
      });
      expect(Buffer.from(String(calls[0]?.body.data_base64), "base64")).toEqual(
        initial,
      );
      const appended = Buffer.from('{"last":true}\n');
      await appendFile(path, appended);
      await captureNativeSession(source, ID, scope, env, {
        baseUrl: url,
        apiKey: "test",
        cloudUrl: "https://api.letta.com",
      });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.body.chunk_index).toBe(1);
      expect(Buffer.from(String(calls[1]?.body.data_base64), "base64")).toEqual(
        appended,
      );
      await captureNativeSession(
        source,
        ID,
        { ...scope, agentId: "other" },
        env,
        { baseUrl: url, apiKey: "test", cloudUrl: "https://api.letta.com" },
      );
      expect(calls).toHaveLength(2);
    },
  );

  test("chunks large native records by bytes without loss", async () => {
    const native = Buffer.from(
      `${JSON.stringify({ text: "𝄞".repeat(180_000) })}\n`,
    );
    const { env } = await fixture("claude_code", native);
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls);
    rememberNativeSession("claude_code", ID, scope, "https://api.letta.com");
    await captureNativeSession("claude_code", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    expect(calls.length).toBeGreaterThan(2);
    expect(
      calls.every(
        ({ body }) =>
          Buffer.from(String(body.data_base64), "base64").length <= 256 * 1024,
      ),
    ).toBe(true);
    expect(
      Buffer.concat(
        calls.map(({ body }) =>
          Buffer.from(String(body.data_base64), "base64"),
        ),
      ),
    ).toEqual(native);
  });

  test("missing store, unknown resume and upload failure do not advance offsets", async () => {
    directory = await mkdtemp(join(tmpdir(), "native-session-capture-"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    let url = await endpoint(calls, true);
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    await captureNativeSession(
      "codex",
      ID,
      scope,
      { HOME: directory },
      { baseUrl: url, apiKey: "test", cloudUrl: "https://api.letta.com" },
    );
    expect(calls).toHaveLength(0);
    const native = Buffer.from('{"hello":"world"}\n');
    const { path, env } = await fixture("codex", native);
    await expect(
      captureNativeSession("codex", ID, scope, env, {
        baseUrl: url,
        apiKey: "test",
        cloudUrl: "https://api.letta.com",
      }),
    ).rejects.toThrow("503");
    expect(await readFile(path)).toEqual(native);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    url = await endpoint(calls);
    await captureNativeSession("codex", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    expect(calls.map(({ body }) => body.chunk_index)).toEqual([0, 0]);
    clearNativeSessionCaptureForTests();
    await captureNativeSession("codex", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    expect(calls).toHaveLength(2);
  });

  test("does not upload for a non-Cloud backend", async () => {
    const { env } = await fixture("claude_code", Buffer.from("{}\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    await endpoint(calls);
    rememberNativeSession("claude_code", ID, scope, "http://localhost:8283");
    await captureNativeSession("claude_code", ID, scope, env, {
      cloudUrl: "http://localhost:8283",
    });
    expect(calls).toHaveLength(0);
  });
});
