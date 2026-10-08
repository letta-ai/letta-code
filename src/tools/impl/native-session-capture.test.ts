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
  awaitNativeSessionCaptureDrainForTests,
  clearNativeSessionCaptureForTests,
  findNativeSessionPath,
  NATIVE_SESSION_CAPTURE_CHUNK_BYTES,
  rememberNativeSession,
  reserveNativeSessionCapture,
  captureNativeSession as sealNativeSession,
  setNativeSessionCaptureDrainHookForTests,
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

async function captureNativeSession(
  ...args: Parameters<typeof sealNativeSession>
): Promise<void> {
  await sealNativeSession(...args);
  await awaitNativeSessionCaptureDrainForTests(args[0], args[1]);
}

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
  fail:
    | boolean
    | number
    | ((requestNumber: number) => boolean | number) = false,
  beforeResponse?: (requestNumber: number) => Promise<void>,
  responseBody?: (body: Record<string, unknown>) => Record<string, unknown>,
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
    const failure = typeof fail === "function" ? fail(calls.length) : fail;
    if (failure) {
      response
        .writeHead(typeof failure === "number" ? failure : 503)
        .end('{"error":"unavailable"}');
      return;
    }
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        responseBody?.(body) ?? {
          chunk_index: body.chunk_index,
          accepted_bytes: Buffer.from(String(body.data_base64), "base64")
            .length,
        },
      ),
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("native CLI JSONL capture", () => {
  test("shares discovery and upload when two captures start together", async () => {
    const { path, env } = await fixture("claude_code", Buffer.from("first\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls);
    rememberNativeSession("claude_code", ID, scope, "https://api.letta.com");
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    await Promise.all([
      captureNativeSession("claude_code", ID, scope, env, options),
      captureNativeSession("claude_code", ID, scope, env, options),
    ]);
    expect(calls).toHaveLength(1);
    await appendFile(path, "second\n");
    await captureNativeSession("claude_code", ID, scope, env, options);
    expect(
      calls.map(({ body }) =>
        Buffer.from(String(body.data_base64), "base64").toString(),
      ),
    ).toEqual(["first\n", "second\n"]);
  });

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

  test("an in-place rewrite during upload cannot corrupt the captured EOF", async () => {
    const native = Buffer.alloc(256 * 1024 * 2 + 17, "a");
    const { path, env } = await fixture("codex", native);
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
    const capture = captureNativeSession("codex", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    await received;
    await writeFile(path, Buffer.alloc(native.length, "b"));
    releaseFirst();
    await capture;
    expect(
      Buffer.concat(
        calls.map(({ body }) =>
          Buffer.from(String(body.data_base64), "base64"),
        ),
      ),
    ).toEqual(native);
  });

  test("queued uploads own an immutable copy of caller scope", async () => {
    const { env } = await fixture("codex", Buffer.from("owned\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls);
    const mutableScope = { ...scope };
    rememberNativeSession("codex", ID, mutableScope, "https://api.letta.com");
    const mutableOptions = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    const capture = captureNativeSession(
      "codex",
      ID,
      mutableScope,
      env,
      mutableOptions,
    );
    mutableScope.agentId = "agent-mutated";
    mutableScope.conversationId = "conv-mutated";
    mutableScope.actingUserId = "user-mutated";
    mutableOptions.baseUrl = "http://127.0.0.1:1";
    mutableOptions.apiKey = "mutated";
    await capture;
    expect(calls[0]?.body.agent_id).toBe(scope.agentId);
    expect(calls[0]?.url).toContain(scope.conversationId);
    expect(calls[0]?.actingUser).toBe(scope.actingUserId);
  });

  test("a known native file disappearing rejects capture", async () => {
    const { path, env } = await fixture("codex", Buffer.from("first\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls);
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    await captureNativeSession("codex", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    await rm(path);
    await expect(
      captureNativeSession("codex", ID, scope, env, {
        baseUrl: url,
        apiKey: "test",
        cloudUrl: "https://api.letta.com",
      }),
    ).rejects.toThrow("disappeared before EOF capture");
  });

  test.each(["claude_code", "codex"] as const)(
    "%s snapshots each turn EOF before returning to the next actor",
    async (source) => {
      const { path, env } = await fixture(source, Buffer.from("turn-a\n"));
      const calls: Array<{
        url: string;
        body: Record<string, unknown>;
        actingUser: string | undefined;
      }> = [];
      let releaseFirst!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const url = await endpoint(calls, false, async (number) => {
        if (number === 1) await release;
      });
      const options = {
        baseUrl: url,
        apiKey: "test",
        cloudUrl: "https://api.letta.com",
      };
      const actorA = { ...scope, actingUserId: "actor-a" };
      const actorB = { ...scope, actingUserId: "actor-b" };
      rememberNativeSession(source, ID, actorA, "https://api.letta.com");

      await sealNativeSession(source, ID, actorA, env, options);
      await appendFile(path, "turn-b\n");
      await sealNativeSession(source, ID, actorB, env, options);
      releaseFirst();
      await awaitNativeSessionCaptureDrainForTests(source, ID);

      expect(
        calls.map((call) => ({
          actor: call.actingUser,
          data: Buffer.from(String(call.body.data_base64), "base64").toString(),
        })),
      ).toEqual([
        { actor: "actor-a", data: "turn-a\n" },
        { actor: "actor-b", data: "turn-b\n" },
      ]);
    },
  );

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
      await appendFile(path, '{"actor":"new"}\n');
      await captureNativeSession(
        source,
        ID,
        { ...scope, actingUserId: "user-next" },
        env,
        { baseUrl: url, apiKey: "test", cloudUrl: "https://api.letta.com" },
      );
      expect(calls[2]?.actingUser).toBe("user-next");
      await captureNativeSession(
        source,
        ID,
        { ...scope, agentId: "other" },
        env,
        { baseUrl: url, apiKey: "test", cloudUrl: "https://api.letta.com" },
      );
      await captureNativeSession(
        source,
        ID,
        { ...scope, conversationId: "conv-other" },
        env,
        { baseUrl: url, apiKey: "test", cloudUrl: "https://api.letta.com" },
      );
      expect(calls).toHaveLength(3);
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
    const url = await endpoint(calls, (requestNumber) => requestNumber === 1);
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    await expect(
      sealNativeSession(
        "codex",
        ID,
        scope,
        { HOME: directory },
        { baseUrl: url, apiKey: "test", cloudUrl: "https://api.letta.com" },
      ),
    ).rejects.toThrow("not found before EOF capture");
    expect(calls).toHaveLength(0);
    await clearNativeSessionCaptureForTests();
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
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
    const later = Buffer.from('{"later":"actor"}\n');
    await appendFile(path, later);
    const laterScope = { ...scope, actingUserId: "user-later" };
    await captureNativeSession("codex", ID, laterScope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    expect(calls.map(({ body }) => body.chunk_index)).toEqual([0, 0, 1]);
    expect(calls.map(({ actingUser }) => actingUser)).toEqual([
      "user-parent",
      "user-parent",
      "user-later",
    ]);
    expect(
      Buffer.concat(
        calls
          .slice(1)
          .map(({ body }) => Buffer.from(String(body.data_base64), "base64")),
      ),
    ).toEqual(Buffer.concat([native, later]));
    await clearNativeSessionCaptureForTests();
    await captureNativeSession("codex", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    expect(calls).toHaveLength(3);
  });

  test("retries a final sealed segment without waiting for another turn", async () => {
    const native = Buffer.from('{"final":"turn"}\n');
    const { env } = await fixture("codex", native);
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls, (requestNumber) => requestNumber === 1);
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");

    await sealNativeSession("codex", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    for (let attempt = 0; attempt < 20 && calls.length < 2; attempt += 1) {
      await Bun.sleep(20);
    }
    await awaitNativeSessionCaptureDrainForTests("codex", ID);

    expect(calls).toHaveLength(2);
    expect(Buffer.from(String(calls[1]?.body.data_base64), "base64")).toEqual(
      native,
    );
  });

  test("retries transient local spool I/O before uploading immutable bytes", async () => {
    const { env } = await fixture("codex", Buffer.from("local-io\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls);
    let attempts = 0;
    setNativeSessionCaptureDrainHookForTests(async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error("file table pressure"), {
          code: "EMFILE",
        });
      }
    });
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    await sealNativeSession("codex", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    await Bun.sleep(800);
    await expect(
      awaitNativeSessionCaptureDrainForTests("codex", ID),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(calls).toHaveLength(1);
    expect(
      Buffer.from(String(calls[0]?.body.data_base64), "base64").toString(),
    ).toBe("local-io\n");
  });

  test.each([
    [undefined, "ambient-user"],
    [null, undefined],
  ] as const)(
    "native upload actor %s preserves tri-state inheritance",
    async (actingUserId, expected) => {
      const previousActor = process.env.LETTA_ACTING_USER_ID;
      process.env.LETTA_ACTING_USER_ID = "ambient-user";
      try {
        const { env } = await fixture("claude_code", Buffer.from("{}\n"));
        const calls: Array<{
          url: string;
          body: Record<string, unknown>;
          actingUser: string | undefined;
        }> = [];
        const url = await endpoint(calls);
        const actorScope = { ...scope, actingUserId };
        rememberNativeSession(
          "claude_code",
          ID,
          actorScope,
          "https://api.letta.com",
        );
        await captureNativeSession("claude_code", ID, actorScope, env, {
          baseUrl: url,
          apiKey: "test",
          cloudUrl: "https://api.letta.com",
        });
        expect(calls[0]?.actingUser).toBe(expected);
      } finally {
        if (previousActor === undefined)
          delete process.env.LETTA_ACTING_USER_ID;
        else process.env.LETTA_ACTING_USER_ID = previousActor;
      }
    },
  );

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

  test("seals rapid turns into non-overlapping actor-owned segments while upload is stalled", async () => {
    const { path, env } = await fixture("codex", Buffer.from("one\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const url = await endpoint(calls, false, async (number) => {
      if (number === 1) await gate;
    });
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    await sealNativeSession(
      "codex",
      ID,
      { ...scope, actingUserId: "one" },
      env,
      options,
    );
    await appendFile(path, "two\n");
    await sealNativeSession(
      "codex",
      ID,
      { ...scope, actingUserId: "two" },
      env,
      options,
    );
    await appendFile(path, "three\n");
    await sealNativeSession(
      "codex",
      ID,
      { ...scope, actingUserId: "three" },
      env,
      options,
    );
    release();
    await awaitNativeSessionCaptureDrainForTests("codex", ID);
    expect(
      calls.map((call) => ({
        actor: call.actingUser,
        data: Buffer.from(String(call.body.data_base64), "base64").toString(),
      })),
    ).toEqual([
      { actor: "one", data: "one\n" },
      { actor: "two", data: "two\n" },
      { actor: "three", data: "three\n" },
    ]);
  });

  test("blocks the next actor until async discovery seals the prior boundary", async () => {
    const { path, env } = await fixture("codex", Buffer.from("actor-a\n"));
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
    let entered!: () => void;
    const discovered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setNativeSessionCaptureSealHookForTests(async () => {
      entered();
      await gate;
    });
    const actorA = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-a" },
      env,
      options,
    );
    const captureA = actorA.capture();
    await discovered;
    let actorBStarted = false;
    const captureB = reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-b" },
      env,
      options,
    ).then(async (actorB) => {
      actorBStarted = true;
      await appendFile(path, "actor-b\n");
      await actorB.capture();
    });
    await Bun.sleep(0);
    expect(actorBStarted).toBe(false);
    release();
    await captureA;
    setNativeSessionCaptureSealHookForTests(undefined);
    await captureB;
    await awaitNativeSessionCaptureDrainForTests("codex", ID);
    expect(
      calls.map((call) => ({
        actor: call.actingUser,
        data: Buffer.from(String(call.body.data_base64), "base64").toString(),
      })),
    ).toEqual([
      { actor: "actor-a", data: "actor-a\n" },
      { actor: "actor-b", data: "actor-b\n" },
    ]);
  });

  test("retries a transient seal for the same actor before admitting the next", async () => {
    const { path, env } = await fixture("codex", Buffer.from("actor-a\n"));
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
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("transient EMFILE"), { code: "EMFILE" });
      }
    });
    const actorA = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-a" },
      env,
      options,
    );
    await actorA.capture();
    setNativeSessionCaptureSealHookForTests(undefined);
    const actorB = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-b" },
      env,
      options,
    );
    await appendFile(path, "actor-b\n");
    await actorB.capture();
    await awaitNativeSessionCaptureDrainForTests("codex", ID);
    expect(attempts).toBe(2);
    expect(
      calls.map((call) => ({
        actor: call.actingUser,
        data: Buffer.from(String(call.body.data_base64), "base64").toString(),
      })),
    ).toEqual([
      { actor: "actor-a", data: "actor-a\n" },
      { actor: "actor-b", data: "actor-b\n" },
    ]);
  });

  test("drops a permanently rejected spool without autonomous retries", async () => {
    const { path, env } = await fixture("codex", Buffer.from("rejected\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls, 400);
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    await sealNativeSession("codex", ID, scope, env, options);
    await expect(
      awaitNativeSessionCaptureDrainForTests("codex", ID),
    ).rejects.toThrow(/400/);
    await Bun.sleep(350);
    expect(calls).toHaveLength(1);

    await appendFile(path, "next\n");
    await sealNativeSession("codex", ID, scope, env, options);
    await expect(
      awaitNativeSessionCaptureDrainForTests("codex", ID),
    ).rejects.toThrow(/400/);
    expect(calls).toHaveLength(2);
    expect(
      Buffer.from(String(calls[1]?.body.data_base64), "base64").toString(),
    ).toBe("next\n");
  });

  test("a permanent rejection drops only its actor segment and drains the next actor", async () => {
    const { path, env } = await fixture("codex", Buffer.from("actor-a\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const url = await endpoint(
      calls,
      (requestNumber) => (requestNumber === 1 ? 400 : false),
      async (requestNumber) => {
        if (requestNumber === 1) {
          entered();
          await gate;
        }
      },
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
    await firstEntered;

    const actorB = await reserveNativeSessionCapture(
      "codex",
      ID,
      { ...scope, actingUserId: "actor-b" },
      env,
      options,
    );
    await appendFile(path, "actor-b\n");
    await actorB.capture();
    release();
    await Bun.sleep(50);
    await expect(
      awaitNativeSessionCaptureDrainForTests("codex", ID),
    ).resolves.toBeUndefined();
    expect(
      calls.map((call) => ({
        actor: call.actingUser,
        data: Buffer.from(String(call.body.data_base64), "base64").toString(),
      })),
    ).toEqual([
      { actor: "actor-a", data: "actor-a\n" },
      { actor: "actor-b", data: "actor-b\n" },
    ]);
  });

  test("drops an acknowledgment mismatch without retrying or retaining its spool", async () => {
    const { path, env } = await fixture("codex", Buffer.from("mismatch\n"));
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    const url = await endpoint(calls, false, undefined, (body) => ({
      chunk_index: body.chunk_index,
      accepted_bytes: 0,
    }));
    const options = {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    };
    rememberNativeSession("codex", ID, scope, "https://api.letta.com");
    await sealNativeSession("codex", ID, scope, env, options);
    await expect(
      awaitNativeSessionCaptureDrainForTests("codex", ID),
    ).rejects.toThrow("acknowledgment mismatch");
    await Bun.sleep(350);
    expect(calls).toHaveLength(1);

    await appendFile(path, "next\n");
    await sealNativeSession("codex", ID, scope, env, options);
    await expect(
      awaitNativeSessionCaptureDrainForTests("codex", ID),
    ).rejects.toThrow("acknowledgment mismatch");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.body.chunk_index)).toEqual([0, 1]);
    expect(
      Buffer.from(String(calls[1]?.body.data_base64), "base64").toString(),
    ).toBe("next\n");
  });

  test("capture resolves after asynchronous bounded sealing without waiting for upload", async () => {
    const native = Buffer.alloc(NATIVE_SESSION_CAPTURE_CHUNK_BYTES * 12, "x");
    const { env } = await fixture("claude_code", native);
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      actingUser: string | undefined;
    }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const url = await endpoint(calls, false, async () => gate);
    rememberNativeSession("claude_code", ID, scope, "https://api.letta.com");
    let yielded = false;
    setTimeout(() => {
      yielded = true;
    }, 0);
    await sealNativeSession("claude_code", ID, scope, env, {
      baseUrl: url,
      apiKey: "test",
      cloudUrl: "https://api.letta.com",
    });
    expect(yielded).toBe(true);
    expect(calls).toHaveLength(0);
    release();
    await awaitNativeSessionCaptureDrainForTests("claude_code", ID);
    expect(calls.length).toBeGreaterThan(1);
    expect(
      calls.every(
        (call) =>
          Buffer.from(String(call.body.data_base64), "base64").length <=
          NATIVE_SESSION_CAPTURE_CHUNK_BYTES,
      ),
    ).toBe(true);
  });

  test.each([
    ["rewrite", (path: string) => writeFile(path, "second\n")],
    ["truncation", (path: string) => writeFile(path, "x")],
  ] as const)(
    "fails closed on source %s during sealing",
    async (_name, mutate) => {
      const { path, env } = await fixture("codex", Buffer.from("first\n"));
      rememberNativeSession("codex", ID, scope, "https://api.letta.com");
      setNativeSessionCaptureSealHookForTests(async () => mutate(path));
      await expect(
        sealNativeSession("codex", ID, scope, env, {
          cloudUrl: "https://api.letta.com",
        }),
      ).rejects.toThrow(/changed|truncated/);
      setNativeSessionCaptureSealHookForTests(undefined);
      await expect(
        sealNativeSession("codex", ID, scope, env, {
          cloudUrl: "https://api.letta.com",
        }),
      ).resolves.toBeUndefined();
    },
  );
});
