import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import {
  rememberConversation,
  resetOpenAiCompatState,
  resolveConversationId,
} from "@/websocket/app-server-openai-common";
import { __testSetRunTurnImpl } from "@/websocket/app-server-openai-turn";

describe("local server durable chat bindings", () => {
  let directory: string;
  let storageDir: string;
  let backend: LocalBackend;
  let agentId: string;
  let key: string;
  let handle: AppServerHandle | undefined;
  let previousEnv: Record<string, string | undefined>;
  const turns: string[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "letta-chat-bindings-"));
    storageDir = join(directory, "backend");
    previousEnv = {};
    for (const [name, value] of Object.entries({
      LETTA_CONFIG_DIR: join(directory, "config"),
      LETTA_LOCAL_BACKEND_DIR: storageDir,
      LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
    })) {
      previousEnv[name] = process.env[name];
      process.env[name] = value;
    }
    await settingsManager.reset();
    await settingsManager.initialize();
    resetOpenAiCompatState();
    backend = new LocalBackend({ storageDir, memfsEnabled: false });
    agentId = (await backend.createAgent({ name: "chat-binding-test" })).id;
    key = `chat-key:${agentId}:fixture-chat`;
    __testSetBackend(backend);
    turns.length = 0;
    __testSetRunTurnImpl(async ({ conversationId }) => {
      turns.push(conversationId);
      return {
        text: "pong",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        error: null,
      };
    });
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    resetOpenAiCompatState();
    __testSetRunTurnImpl(null);
    __testSetBackend(null);
    await settingsManager.reset();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  function bindingPath(chatKey = key): string {
    return join(
      storageDir,
      "openai-chat-bindings-v1",
      `${createHash("sha256").update(chatKey).digest("hex")}.json`,
    );
  }

  async function resolveAndRemember(chatKey = key, agent = agentId) {
    const id = await resolveConversationId(agent, chatKey);
    rememberConversation(chatKey, id);
    return id;
  }

  async function start(): Promise<void> {
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });
  }

  async function request(
    endpoint: string,
    history = false,
    extra = {},
    header = "x-openwebui-chat-id",
  ) {
    if (!handle) throw new Error("Expected a running server");
    const url = new URL(handle.url);
    const messages = history
      ? [
          { role: "user", content: "Earlier input" },
          { role: "assistant", content: "Earlier reply" },
          { role: "user", content: "Continue" },
        ]
      : [{ role: "user", content: "Reply with pong" }];
    return fetch(`http://${url.host}/v1/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [header]: "fixture-chat",
      },
      body: JSON.stringify({
        model: agentId,
        stream: true,
        ...(endpoint === "responses"
          ? {
              input: messages.map((message) => ({
                type: "message",
                ...message,
              })),
            }
          : { messages }),
        ...extra,
      }),
      signal: AbortSignal.timeout(3000),
    });
  }

  test("reuses the same disk-backed conversation after losing all process maps", async () => {
    const original = await resolveAndRemember();
    resetOpenAiCompatState();
    backend = new LocalBackend({ storageDir, memfsEnabled: false });
    __testSetBackend(backend);
    expect(await resolveAndRemember()).toBe(original);
  });

  test("concurrent first requests publish one mapping inside the creation queue", async () => {
    const originalCreate = backend.createConversation.bind(backend);
    backend.createConversation = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return originalCreate(...args);
    };
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => resolveAndRemember()),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await backend.listConversations({ agent_id: agentId })).toHaveLength(
      1,
    );
  });

  test("cache eviction preserves the durable chat identity", async () => {
    const original = await resolveAndRemember();
    for (let index = 0; index < 4096; index += 1) {
      rememberConversation(`chat-key:${agentId}:other-${index}`, original);
    }
    expect(await resolveAndRemember()).toBe(original);
  });

  test("the same external chat key is isolated by agent", async () => {
    const original = await resolveAndRemember();
    const other = (await backend.createAgent({ name: "other-agent" })).id;
    const second = await resolveAndRemember(
      `chat-key:${other}:fixture-chat`,
      other,
    );
    resetOpenAiCompatState();
    expect(await resolveAndRemember()).toBe(original);
    expect(
      await resolveAndRemember(`chat-key:${other}:fixture-chat`, other),
    ).toBe(second);
    expect(second).not.toBe(original);
  });

  test("uses hashed filenames and private permissions without persisting chat text", async () => {
    const unsafeKey = `chat-key:${agentId}:../../chat?private=fixture`;
    const id = await resolveAndRemember(unsafeKey);
    const path = bindingPath(unsafeKey);
    const contents = await readFile(path, "utf8");
    expect(JSON.parse(contents)).toEqual({
      version: 1,
      key_sha256: createHash("sha256").update(unsafeKey).digest("hex"),
      agent_id: agentId,
      conversation_id: id,
    });
    expect(contents).not.toContain("private=fixture");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });

  test("a transient backend failure preserves the binding and allows a later retry", async () => {
    const original = await resolveAndRemember();
    const saved = await readFile(bindingPath(), "utf8");
    const retrieve = backend.retrieveConversation.bind(backend);
    backend.retrieveConversation = async () => {
      throw new Error("Backend temporarily unavailable");
    };
    await expect(resolveAndRemember()).rejects.toThrow("unavailable");
    expect(await readFile(bindingPath(), "utf8")).toBe(saved);
    backend.retrieveConversation = retrieve;
    expect(await resolveAndRemember()).toBe(original);
    expect(await backend.listConversations({ agent_id: agentId })).toHaveLength(
      1,
    );
  });

  test("a binding commit failure leaves input unsubmitted and no cache-only mapping", async () => {
    const create = backend.createConversation.bind(backend);
    backend.createConversation = async (...args) => {
      const conversation = await create(...args);
      await writeFile(dirname(bindingPath()), "not a directory");
      return conversation;
    };
    await start();
    const rejected = await request("chat/completions");
    expect(rejected.status).toBe(503);
    await rejected.text();
    expect(turns).toHaveLength(0);
    await rm(dirname(bindingPath()));
    backend.createConversation = create;
    const retried = await request("chat/completions");
    expect(retried.status).toBe(200);
    await retried.text();
    expect(turns).toHaveLength(1);
    expect(
      JSON.parse(await readFile(bindingPath(), "utf8")).conversation_id,
    ).toBe(turns[0]);
  });

  test("a stored-response fork replaces the saved binding for later requests", async () => {
    await start();
    const first = await request(
      "responses",
      false,
      { stream: false, store: true },
      "x-letta-chat-key",
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { id: string };
    const second = await request(
      "responses",
      false,
      { stream: false, store: true, previous_response_id: firstBody.id },
      "x-letta-chat-key",
    );
    expect(second.status).toBe(200);
    await second.text();
    const fork = turns[1];
    expect(fork).toBeDefined();
    expect(fork).not.toBe(turns[0]);
    resetOpenAiCompatState();
    const continued = await request("chat/completions", true);
    expect(continued.status).toBe(200);
    await continued.text();
    expect(turns[2]).toBe(fork);
  });

  test("restoring an older binding cannot overwrite a fork made during retrieval", async () => {
    const original = await resolveAndRemember();
    const fork = await backend.forkConversation(original, { agentId });
    const retrieve = backend.retrieveConversation.bind(backend);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.retrieveConversation = async (...args) => {
      started();
      await gate;
      return retrieve(...args);
    };
    const restoring = resolveConversationId(agentId, key);
    await waiting;
    rememberConversation(key, fork.id);
    release();
    expect(await restoring).toBe(original);
    backend.retrieveConversation = retrieve;
    resetOpenAiCompatState();
    expect(await resolveAndRemember()).toBe(fork.id);
  });

  for (const endpoint of ["chat/completions", "responses"]) {
    for (const stream of [false, true]) {
      test(`${endpoint} restores context after restart (stream=${stream})`, async () => {
        const header = stream ? "x-openwebui-chat-id" : "x-letta-chat-key";
        await start();
        const first = await request(endpoint, false, { stream }, header);
        expect(first.status).toBe(200);
        await first.text();
        const original = turns[0];
        if (!original) throw new Error("Expected the first request's turn");
        await handle?.close();
        handle = undefined;
        resetOpenAiCompatState();
        backend = new LocalBackend({ storageDir, memfsEnabled: false });
        __testSetBackend(backend);
        await start();
        const second = await request(endpoint, true, { stream }, header);
        expect(second.status).toBe(200);
        await second.text();
        expect(turns).toEqual([original, original]);
      });
    }

    test(`${endpoint} keeps non-streaming WebUI background tasks out of the pinned chat`, async () => {
      const original = await resolveAndRemember();
      await start();
      const background = await request(endpoint, true, { stream: false });
      expect(background.status).toBe(200);
      await background.text();
      expect(turns).toHaveLength(1);
      expect(turns[0]).not.toBe(original);
      expect(await resolveAndRemember()).toBe(original);
    });

    test(`${endpoint} refuses an unbound historical chat before running a turn`, async () => {
      await start();
      const response = await request(endpoint, true);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "conversation_binding_unavailable" },
      });
      expect(turns).toHaveLength(0);
      expect(
        await backend.listConversations({ agent_id: agentId }),
      ).toHaveLength(0);
    });

    test(`${endpoint} preserves pre-upgrade native history when no binding exists`, async () => {
      backend = new LocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const conversation = await backend.createConversation({
        agent_id: agentId,
      });
      const stream = await backend.createConversationMessageStream(
        conversation.id,
        {
          agent_id: agentId,
          messages: [{ role: "user", content: "Earlier input" }],
        },
      );
      for await (const chunk of stream) void chunk;
      const conversationsDir = join(storageDir, "conversations");
      const snapshot = async () => {
        const contents: Record<string, string> = {};
        for (const entry of await readdir(conversationsDir)) {
          for (const name of await readdir(join(conversationsDir, entry))) {
            const relative = join(entry, name);
            contents[relative] = await readFile(
              join(conversationsDir, relative),
              "utf8",
            );
          }
        }
        return contents;
      };
      const before = await snapshot();
      expect(
        Object.values(before).some((text) => text.includes("Earlier input")),
      ).toBe(true);
      await start();
      const rejected = await request(endpoint, true);
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toMatchObject({
        error: { code: "conversation_binding_unavailable" },
      });
      expect(turns).toHaveLength(0);
      expect(await snapshot()).toEqual(before);
      expect(
        await backend.listConversations({ agent_id: agentId }),
      ).toHaveLength(1);
    });

    for (const damage of [
      "malformed",
      "wrong-agent",
      "wrong-native-agent",
      "deleted-conversation",
      "missing-file",
      "disk-error",
    ]) {
      test(`${endpoint} refuses ${damage} bindings before submitting input`, async () => {
        const original = await resolveAndRemember();
        if (damage === "malformed") {
          await mkdir(dirname(bindingPath()), { recursive: true });
          await writeFile(bindingPath(), "{broken");
        } else if (damage === "wrong-agent") {
          const record = {
            version: 1,
            key_sha256: createHash("sha256").update(key).digest("hex"),
            agent_id: "another-agent",
            conversation_id: original,
          };
          await mkdir(dirname(bindingPath()), { recursive: true });
          await writeFile(bindingPath(), JSON.stringify(record));
        } else if (damage === "wrong-native-agent") {
          const other = (await backend.createAgent({ name: "other-agent" })).id;
          const conversation = await backend.createConversation({
            agent_id: other,
          });
          rememberConversation(key, conversation.id);
        } else if (damage === "deleted-conversation") {
          await rm(join(storageDir, "conversations"), {
            recursive: true,
            force: true,
          });
          backend = new LocalBackend({ storageDir, memfsEnabled: false });
          __testSetBackend(backend);
        } else if (damage === "missing-file") {
          await rm(bindingPath(), { force: true });
        } else {
          await rm(dirname(bindingPath()), { recursive: true, force: true });
          await writeFile(dirname(bindingPath()), "not a directory");
        }
        await start();
        const response = await request(endpoint);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: "conversation_binding_unavailable" },
        });
        expect(turns).toHaveLength(0);
      });
    }
  }
});
