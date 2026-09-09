import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "@/backend";
import type { HeadlessTurnExecutorInput } from "@/backend/dev/headless-turn-executor";
import {
  ProviderTurnExecutor,
  providerLocalMessage,
  providerStreamPart,
} from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage, type LocalAssistantMessage } from "./local-message";
import { projectLocalMessageToStoredMessages } from "./local-message-projection";
import { LocalStore } from "./local-store";
import {
  getAttachedLocalMessage,
  type ProviderStreamPart,
} from "./local-stream-chunks";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-message-correlation-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("local assistant segment correlation", () => {
  test("retains exact live identities through persistence, reload and replay", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-segments";
    const store = new LocalStore(agentId, { storageDir });
    const message: LocalAssistantMessage = {
      id: "provider-final",
      role: "assistant",
      content: [
        { type: "text", text: "same" },
        { type: "text", text: " adjacent" },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
        { type: "text", text: "same" },
        { type: "thinking", thinking: "" },
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "same" },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: emptyLocalUsage(),
      stopReason: "toolUse",
      timestamp: 1,
    };
    const executor = new ProviderTurnExecutor({
      async *stream() {
        for (const [contentIndex, content] of message.content.entries()) {
          if (content.type === "thinking" && !content.thinking) continue;
          yield providerStreamPart({
            type:
              content.type === "text"
                ? "text_delta"
                : content.type === "thinking"
                  ? "thinking_delta"
                  : "toolcall_end",
            contentIndex,
            partial: message,
            ...(content.type === "toolCall"
              ? { toolCall: content }
              : {
                  delta:
                    content.type === "text" ? content.text : content.thinking,
                }),
          } as ProviderStreamPart);
        }
        yield providerLocalMessage(message);
        yield providerStreamPart({
          type: "done",
          reason: "toolUse",
          message,
        } as ProviderStreamPart);
      },
    });
    const input = {
      conversationId: "default",
      agentId,
      agent: { id: agentId, model: "openai/test", model_settings: {} },
      body: { messages: [] },
      history: [],
      uiMessages: [],
    } as unknown as HeadlessTurnExecutorInput;
    const liveOtids: string[] = [];
    let snapshot: LocalAssistantMessage | undefined;
    for await (const chunk of await executor.execute(input)) {
      const stored = store.appendStreamChunk("default", agentId, chunk);
      const otid = (stored as { otid?: string }).otid;
      if (otid && liveOtids.at(-1) !== otid) liveOtids.push(otid);
      const attached = getAttachedLocalMessage(chunk);
      if (attached?.role === "assistant") snapshot = attached;
    }
    expect(liveOtids).toHaveLength(5);
    expect(new Set(liveOtids).size).toBe(5);
    expect(snapshot?.metadata?.stream_provenance).toEqual({
      version: 1,
      segments: (
        [
          [0, 2, "assistant_message"],
          [2, 3, "approval_request_message"],
          [3, 4, "assistant_message"],
          [4, 6, "reasoning_message"],
          [6, 7, "assistant_message"],
        ] as const
      ).map(([start, end, type], index) => ({
        content_start_index: start,
        content_end_index: end,
        message_type: type,
        otid: liveOtids[index] ?? "missing",
      })),
    });
    const list = (source: LocalStore) =>
      source.listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody);
    const history = list(store);
    expect(history.map((row) => (row as { otid?: string }).otid)).toEqual(
      liveOtids,
    );
    const reloaded = new LocalStore(agentId, { storageDir });
    expect(list(reloaded)).toEqual(history);
    expect(list(reloaded)).toEqual(history);
    expect(
      reloaded.listLocalMessages("default", agentId)[0]?.metadata
        ?.stream_provenance,
    ).toEqual(snapshot?.metadata?.stream_provenance);
    // Independent executions with identical text must never alias.
    const secondOtids: string[] = [];
    for await (const chunk of await executor.execute(input)) {
      const otid = (chunk as { otid?: string }).otid;
      if (otid) secondOtids.push(otid);
    }
    expect(secondOtids.every((otid) => !liveOtids.includes(otid))).toBe(true);
    // Legacy rows retain their IDs without fabricated provenance.
    expect(
      projectLocalMessageToStoredMessages(
        message,
        agentId,
        "default",
        "2026-01-01",
      ).every((row) => !("otid" in row)),
    ).toBe(true);
  });
});

describe("local user message correlation", () => {
  test("preserves the inbound otid through projection and transcript reload", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-correlation";
    const otid = "desktop-user-message-1";
    const clientMessageId = "transport-user-message-1";
    const store = new LocalStore(agentId, { storageDir });

    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          otid,
          client_message_id: clientMessageId,
        },
      ],
    } as unknown as ConversationMessageCreateBody);

    expect(store.listLocalMessages("default", agentId)).toEqual([
      expect.objectContaining({ role: "user", otid }),
    ]);
    expect(
      store.listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody),
    ).toEqual([
      expect.objectContaining({ message_type: "user_message", otid }),
    ]);

    const reloaded = new LocalStore(agentId, { storageDir });
    expect(
      reloaded.listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody),
    ).toEqual([
      expect.objectContaining({ message_type: "user_message", otid }),
    ]);
  });

  test("seeds the otid from client_message_id when otid is absent", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-client-correlation";
    const clientMessageId = "transport-user-message-2";
    const store = new LocalStore(agentId, { storageDir });

    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello from an older sender" }],
          client_message_id: clientMessageId,
        },
      ],
    } as unknown as ConversationMessageCreateBody);

    const reloaded = new LocalStore(agentId, { storageDir });
    expect(
      reloaded.listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody),
    ).toEqual([
      expect.objectContaining({
        message_type: "user_message",
        otid: clientMessageId,
      }),
    ]);
  });
});
