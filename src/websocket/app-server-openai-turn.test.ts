import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { QueueRuntime } from "@/queue/queue-runtime";
import { settingsManager } from "@/settings-manager";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import {
  rememberConversation,
  resetOpenAiCompatState,
} from "@/websocket/app-server-openai-common";
import { __testSetRunTurnImpl } from "@/websocket/app-server-openai-turn";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createAcceptedInputDispositionLedger } from "@/websocket/listener/input-disposition";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";

describe("OpenAI bridge durable admission", () => {
  let directory: string;
  let previousConfigDir: string | undefined;
  let backend: LocalBackend;
  let agentId: string;
  let handle: AppServerHandle;
  let listener: ListenerRuntime;
  let ledgerPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "letta-openai-admission-"));
    previousConfigDir = process.env.LETTA_CONFIG_DIR;
    process.env.LETTA_CONFIG_DIR = directory;
    await settingsManager.reset();
    await settingsManager.initialize();
    resetOpenAiCompatState();
    __testSetRunTurnImpl(null);
    backend = new LocalBackend({
      storageDir: join(directory, "backend"),
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "admission-test" });
    agentId = agent.id;
    __testSetBackend(backend);
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });
    const active = getActiveRuntime();
    if (!active) throw new Error("Expected the app server runtime");
    listener = active;
    // NODE_ENV=test normally disables persistence, which hides the missing
    // client_message_id regression. Use the real on-disk admission ledger.
    ledgerPath = join(directory, "input-dispositions-v2.json");
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: ledgerPath });
  });

  afterEach(async () => {
    await handle?.close();
    __testSetRunTurnImpl(null);
    resetOpenAiCompatState();
    __testSetBackend(null);
    if (previousConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previousConfigDir;
    await settingsManager.reset();
    await rm(directory, { recursive: true, force: true });
  });

  async function submit(endpoint: string, stream: boolean): Promise<Response> {
    const url = new URL(handle.url);
    url.protocol = "http:";
    const body = {
      model: agentId,
      stream,
      ...(endpoint === "responses"
        ? { input: "Reply with pong" }
        : { messages: [{ role: "user", content: "Reply with pong" }] }),
    };
    return fetch(`${url.origin}/v1/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-letta-chat-key": "admission-test-chat",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  }

  for (const endpoint of ["chat/completions", "responses"]) {
    for (const stream of [false, true]) {
      test(`${endpoint} completes with a durable ledger (stream=${stream})`, async () => {
        const response = await submit(endpoint, stream);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("pong");
        if (stream) {
          expect(text).toContain(
            endpoint === "responses" ? "response.completed" : "[DONE]",
          );
        }
        const conversations = (await backend.listConversations({
          agent_id: agentId,
        })) as unknown as Conversation[];
        expect(conversations).toHaveLength(1);
        const conversation = conversations[0];
        if (!conversation) throw new Error("Expected the keyed conversation");
        const page = await backend.listConversationMessages(conversation.id, {
          order: "asc",
        });
        const messages = page.getPaginatedItems();
        expect(
          messages.filter((message) => message.message_type === "user_message"),
        ).toHaveLength(1);
        const store = JSON.parse(await readFile(ledgerPath, "utf8")) as {
          entries: Record<string, unknown>;
        };
        expect(Object.keys(store.entries)).toHaveLength(1);
        expect(listener.streamObservers?.size).toBe(0);
      });
    }

    test(`${endpoint} terminates a rejected stream before executing input`, async () => {
      const conversation = await backend.createConversation({
        agent_id: agentId,
      });
      rememberConversation(
        `chat-key:${agentId}:admission-test-chat`,
        conversation.id,
      );
      const runtime = getOrCreateScopedRuntime(
        listener,
        agentId,
        conversation.id,
      );
      runtime.queueRuntime = new QueueRuntime({ maxItems: 1, hardMaxItems: 1 });
      runtime.queueRuntime.enqueue({
        kind: "message",
        source: "user",
        content: "Existing pending input",
        clientMessageId: "pending-input",
        agentId,
        conversationId: conversation.id,
      });
      const response = await submit(endpoint, true);
      const text = await response.text();
      expect(text).toContain("rejected before queue admission");
      expect(text).toContain(
        endpoint === "responses" ? "response.failed" : "[DONE]",
      );
      const page = await backend.listConversationMessages(conversation.id, {});
      expect(page.getPaginatedItems()).toHaveLength(0);
      expect(runtime.queueRuntime.length).toBe(1);
      expect(listener.streamObservers?.size).toBe(0);
    });
  }

  test("an asynchronous admission-store failure finishes the request", async () => {
    const blocked = join(directory, "not-a-ledger-file");
    await mkdir(blocked);
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: blocked });
    const response = await submit("chat/completions", false);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("rejected before queue admission");
    expect(listener.streamObservers?.size).toBe(0);
  });
});
