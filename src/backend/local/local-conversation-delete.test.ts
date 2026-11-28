import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { LocalBackend } from "./local-backend";
import { LocalBackendNotFoundError, LocalStore } from "./local-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function conversationDir(root: string, conversationId: string): string {
  return join(
    root,
    "conversations",
    Buffer.from(`conversation:${conversationId}`).toString("base64url"),
  );
}

function appendExchange(
  store: LocalStore,
  conversationId: string,
  agentId: string,
  text: string,
): void {
  store.appendTurnInput(conversationId, {
    agent_id: agentId,
    messages: [{ role: "user", content: text }],
  });
  store.appendStreamChunk(conversationId, agentId, {
    message_type: "assistant_message",
    id: `provider-${text}`,
    date: "2026-01-01T00:00:00Z",
    content: [{ type: "text", text: `reply: ${text}` }],
  } as never);
  store.appendStreamChunk(conversationId, agentId, {
    message_type: "stop_reason",
    stop_reason: "end_turn",
  } as never);
}

function messageIds(store: LocalStore, conversationId: string): string[] {
  return store
    .listConversationMessages(conversationId)
    .map((message) => message.id);
}

describe("local conversation delete", () => {
  test("removes only the target conversation, on disk and after reload", () => {
    const root = temporaryRoot("local-conversation-delete-");
    const agentId = "agent-local-delete";
    const store = new LocalStore(agentId, { storageDir: root });
    const doomed = store.createConversation({ agent_id: agentId });
    const kept = store.createConversation({ agent_id: agentId });
    appendExchange(store, doomed.id, agentId, "doomed");
    appendExchange(store, kept.id, agentId, "kept");
    const doomedMessageIds = messageIds(store, doomed.id);
    const keptMessageIds = messageIds(store, kept.id);
    expect(doomedMessageIds.length).toBeGreaterThan(0);
    expect(store.retrieveMessage(doomedMessageIds[0] as string)).not.toEqual(
      [],
    );

    store.deleteConversation(doomed.id);

    expect(existsSync(conversationDir(root, doomed.id))).toBe(false);
    expect(existsSync(conversationDir(root, kept.id))).toBe(true);
    expect(store.retrieveMessage(doomedMessageIds[0] as string)).toEqual([]);
    expect(messageIds(store, kept.id)).toEqual(keptMessageIds);
    expect(
      store.listConversations().map((conversation) => conversation.id),
    ).not.toContain(doomed.id);

    const reloaded = new LocalStore(agentId, {
      storageDir: root,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });
    const reloadedIds = reloaded
      .listConversations()
      .map((conversation) => conversation.id);
    expect(reloadedIds).toContain(kept.id);
    expect(reloadedIds).not.toContain(doomed.id);
    expect(() => reloaded.retrieveConversation(doomed.id)).toThrow(
      LocalBackendNotFoundError,
    );
    expect(messageIds(reloaded, kept.id)).toEqual(keptMessageIds);
  });

  test("removes an agent-free conversation without touching agents", () => {
    const root = temporaryRoot("local-conversation-delete-agent-free-");
    const parentId = "agent-local-parent";
    const store = new LocalStore(parentId, {
      storageDir: root,
      strictConversationAccess: true,
    });
    const agentsBefore = store.listAgents();
    const conversation = store.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "worker",
    });
    expect(existsSync(conversationDir(root, conversation.id))).toBe(true);

    store.deleteConversation(conversation.id);

    expect(existsSync(conversationDir(root, conversation.id))).toBe(false);
    expect(store.isAgentFreeConversation(conversation.id)).toBe(false);
    expect(() => store.retrieveConversation(conversation.id)).toThrow(
      LocalBackendNotFoundError,
    );
    expect(store.listAgents()).toEqual(agentsBefore);
  });

  test("rejects the default conversation and unknown ids", () => {
    const root = temporaryRoot("local-conversation-delete-reject-");
    const agentId = "agent-local-reject";
    const store = new LocalStore(agentId, { storageDir: root });
    appendExchange(store, "default", agentId, "default");
    const defaultIds = messageIds(store, "default");

    expect(() => store.deleteConversation("default")).toThrow(
      "Default conversation cannot be deleted",
    );
    expect(() => store.deleteConversation("local-conv-missing")).toThrow(
      LocalBackendNotFoundError,
    );
    expect(messageIds(store, "default")).toEqual(defaultIds);
  });

  test("LocalBackend refuses to delete a conversation with an active run", async () => {
    const root = temporaryRoot("local-conversation-delete-active-run-");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = new LocalBackend({
      storageDir: root,
      memfsEnabled: false,
      executor: {
        async execute() {
          const controller = new AbortController();
          return {
            controller,
            async *[Symbol.asyncIterator]() {
              await gate;
              yield {
                message_type: "stop_reason",
                stop_reason: "end_turn",
              } as LettaStreamingResponse;
            },
          } as unknown as Stream<LettaStreamingResponse>;
        },
      },
    });
    const conversation = await backend.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "worker",
    });
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      { messages: [{ role: "user", content: "hello" }] } as never,
    );

    await expect(backend.deleteConversation(conversation.id)).rejects.toThrow(
      "has an active run",
    );
    expect(existsSync(conversationDir(root, conversation.id))).toBe(true);

    release();
    for await (const _chunk of stream) {
    }

    await backend.deleteConversation(conversation.id);
    expect(existsSync(conversationDir(root, conversation.id))).toBe(false);
    await expect(
      backend.retrieveConversation(conversation.id),
    ).rejects.toBeInstanceOf(LocalBackendNotFoundError);
  });

  test("LocalBackend refuses to delete while chunks after stop_reason are still being saved", async () => {
    const root = temporaryRoot("local-conversation-delete-saving-");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = new LocalBackend({
      storageDir: root,
      memfsEnabled: false,
      executor: {
        async execute() {
          const controller = new AbortController();
          return {
            controller,
            async *[Symbol.asyncIterator]() {
              yield {
                message_type: "stop_reason",
                stop_reason: "end_turn",
              } as LettaStreamingResponse;
              await gate;
              yield {
                message_type: "usage_statistics",
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              } as LettaStreamingResponse;
            },
          } as unknown as Stream<LettaStreamingResponse>;
        },
      },
    });
    const conversation = await backend.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "worker",
    });
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      { messages: [{ role: "user", content: "hello" }] } as never,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ message_type: "stop_reason" });

    await expect(backend.deleteConversation(conversation.id)).rejects.toThrow(
      "still saving a response stream",
    );
    expect(existsSync(conversationDir(root, conversation.id))).toBe(true);

    release();
    while (!(await iterator.next()).done) {}

    await backend.deleteConversation(conversation.id);
    expect(existsSync(conversationDir(root, conversation.id))).toBe(false);
  });

  test("forgets messages indexed from disk for a conversation that was never loaded", () => {
    const root = temporaryRoot("local-conversation-delete-tail-index-");
    const agentId = "agent-local-tail-index";
    const writer = new LocalStore(agentId, { storageDir: root });
    const conversation = writer.createConversation({ agent_id: agentId });
    appendExchange(writer, conversation.id, agentId, "persisted");
    const messageId = messageIds(writer, conversation.id)[0] as string;

    const reader = new LocalStore(agentId, {
      storageDir: root,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });
    expect(reader.retrieveMessage(messageId)).not.toEqual([]);

    reader.deleteConversation(conversation.id);

    expect(() => reader.retrieveMessage(messageId)).toThrow(
      LocalBackendNotFoundError,
    );
  });
});
