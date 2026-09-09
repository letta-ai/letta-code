import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "@/backend";
import {
  emptyLocalUsage,
  type LocalAssistantMessage,
} from "@/backend/local/local-message";
import { LocalStore } from "@/backend/local/local-store";
import {
  attachLocalContentPrefix,
  attachLocalMessage,
  markLocalStateChunkOnly,
} from "@/backend/local/local-stream-chunks";

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

describe("local assistant message correlation", () => {
  test("uses canonical identity for live text before and after transcript reload", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-assistant-correlation";
    const store = new LocalStore(agentId, { storageDir });
    const live = store.appendStreamChunk("default", agentId, {
      message_type: "assistant_message",
      otid: "provider-assistant-transient",
      content: [{ type: "text", text: "One " }],
    } as LettaStreamingResponse);
    const next = store.appendStreamChunk("default", agentId, {
      message_type: "assistant_message",
      otid: "provider-assistant-transient",
      content: [{ type: "text", text: "response" }],
    } as LettaStreamingResponse);
    expect("id" in next ? next.id : undefined).toBe(
      "id" in live ? live.id : undefined,
    );
    store.appendStreamChunk("default", agentId, {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    });
    const canonical = new LocalStore(agentId, {
      storageDir,
    }).listConversationMessages("default", { agent_id: agentId, order: "asc" });

    expect(canonical).toHaveLength(1);
    expect("id" in live ? live.id : undefined).toBe(canonical[0]?.id);
    expect("otid" in live ? live.otid : undefined).toBeUndefined();
    expect(store.listLocalMessages("default", agentId)).toHaveLength(1);
  });
});

describe("local segment identity", () => {
  test("retains provider indices through final snapshots, tools, and reload", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-segments";
    const store = new LocalStore(agentId, { storageDir });
    const content: LocalAssistantMessage["content"] = [
      { type: "thinking", thinking: "first" },
      { type: "thinking", thinking: "second" },
      { type: "text", text: "same" },
      { type: "text", text: " text" },
      { type: "thinking", thinking: "another thought" },
      { type: "text", text: "same text" },
      { type: "toolCall", id: "tool-1", name: "Read", arguments: {} },
      { type: "text", text: "after tool" },
    ];
    const live: LettaStreamingResponse[] = [];
    for (const [index, part] of content.entries()) {
      if (part.type === "toolCall") {
        store.appendStreamChunk("default", agentId, {
          message_type: "approval_request_message",
          tool_call: {
            tool_call_id: part.id,
            name: part.name,
            arguments: "{}",
          },
        } as LettaStreamingResponse);
        continue;
      }
      const delta =
        part.type === "thinking"
          ? { message_type: "reasoning_message", reasoning: part.thinking }
          : {
              message_type: "assistant_message",
              content: [{ type: "text", text: part.text }],
            };
      live.push(
        store.appendStreamChunk(
          "default",
          agentId,
          attachLocalContentPrefix(
            delta as LettaStreamingResponse,
            content,
            index,
          ),
        ),
      );
    }
    const snapshot: LocalAssistantMessage = {
      id: "provider-snapshot",
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openai",
      model: "test-model",
      usage: emptyLocalUsage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    store.appendStreamChunk(
      "default",
      agentId,
      markLocalStateChunkOnly(
        attachLocalMessage({ message_type: "local_message" }, snapshot),
      ) as unknown as LettaStreamingResponse,
    );
    store.appendStreamChunk("default", agentId, {
      message_type: "stop_reason",
      stop_reason: "requires_approval",
    });
    const canonical = new LocalStore(agentId, { storageDir })
      .listConversationMessages("default", { agent_id: agentId, order: "asc" })
      .filter(
        (row) =>
          row.message_type === "assistant_message" ||
          row.message_type === "reasoning_message",
      );
    const key = (row: { message_type?: string }) =>
      `${"id" in row ? row.id : ""}:${row.message_type}`;
    const liveKeys = live.map(key);
    expect([...new Set(liveKeys)]).toEqual(canonical.map(key));
    expect(liveKeys[0]).toBe(liveKeys[1]);
    expect(liveKeys[2]).toBe(liveKeys[3]);
    expect(liveKeys[2]).not.toBe(liveKeys[5]);
    expect(canonical).toHaveLength(5);
    expect(JSON.stringify(live)).not.toContain("local-content-prefix");
  });

  test("keeps identical responses distinct across a restart with existing history", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-repeated-responses";
    const ids: string[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const store = new LocalStore(agentId, { storageDir });
      store.appendTurnInput("default", {
        agent_id: agentId,
        messages: [{ role: "user", content: "again" }],
      } as ConversationMessageCreateBody);
      const live = store.appendStreamChunk("default", agentId, {
        message_type: "assistant_message",
        content: [{ type: "text", text: "identical" }],
      } as LettaStreamingResponse);
      ids.push("id" in live ? live.id : "");
      store.appendStreamChunk("default", agentId, {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      });
    }
    const canonical = new LocalStore(agentId, { storageDir })
      .listConversationMessages("default", { agent_id: agentId, order: "asc" })
      .filter((row) => row.message_type === "assistant_message");
    expect(ids).toEqual(canonical.map((row) => row.id));
    expect(new Set(ids).size).toBe(2);
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
