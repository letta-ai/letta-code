import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  attachLocalMessage,
  attachLocalSegmentIdentity,
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

  test("matches an untagged mixed assistant chunk to its assistant row", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-mixed-assistant-correlation";
    const store = new LocalStore(agentId, { storageDir });
    const live = store.appendStreamChunk("default", agentId, {
      message_type: "assistant_message",
      content: [
        { type: "text", text: "answer" },
        { type: "reasoning", text: "thought" },
      ],
    } as unknown as LettaStreamingResponse);
    store.appendStreamChunk("default", agentId, {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    });

    const canonical = new LocalStore(agentId, { storageDir })
      .listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      })
      .filter(
        (row) =>
          row.message_type === "assistant_message" ||
          row.message_type === "reasoning_message",
      );
    const assistant = canonical.find(
      (row) => row.message_type === "assistant_message",
    );
    const reasoning = canonical.find(
      (row) => row.message_type === "reasoning_message",
    );
    expect("id" in live ? live.id : undefined).toBe(assistant?.id);
    expect("id" in live ? live.id : undefined).not.toBe(reasoning?.id);
  });

  test("matches an untagged reasoning-only assistant chunk to reasoning history", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-reasoning-envelope-correlation";
    const store = new LocalStore(agentId, { storageDir });
    const live = store.appendStreamChunk("default", agentId, {
      message_type: "assistant_message",
      content: [{ type: "reasoning", text: "thought" }],
    } as unknown as LettaStreamingResponse);
    store.appendStreamChunk("default", agentId, {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    });

    const canonical = new LocalStore(agentId, { storageDir })
      .listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      })
      .filter((row) => row.message_type === "reasoning_message");
    expect(canonical).toHaveLength(1);
    expect("id" in live ? live.id : undefined).toBe(canonical[0]?.id);
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
          attachLocalSegmentIdentity(delta as LettaStreamingResponse, {
            contentStartIndex:
              index > 0 && content[index - 1]?.type === part.type
                ? index - 1
                : index,
            useSourceMessageId: part.type === "text" && index === 0,
          }),
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

describe("local transcript residency", () => {
  function conversationMessagesPath(
    storageDir: string,
    conversationKey: string,
  ): string {
    return join(
      storageDir,
      "conversations",
      Buffer.from(conversationKey).toString("base64url"),
      "messages.jsonl",
    );
  }

  function appendTurn(
    store: LocalStore,
    agentId: string,
    text: string,
    conversationId = "default",
  ): void {
    store.appendTurnInput(conversationId, {
      agent_id: agentId,
      messages: [{ role: "user", content: text }],
    } as ConversationMessageCreateBody);
    store.appendStreamChunk(conversationId, agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: `reply: ${text}` }],
    } as LettaStreamingResponse);
    store.appendStreamChunk(conversationId, agentId, {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    });
  }

  test("pages older messages from disk while only a bounded tail stays resident", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-paging";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 4,
    });
    for (let turn = 0; turn < 6; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`);
    }

    // Full-history readers page the whole transcript from disk even though
    // appends only kept the last 4 messages resident.
    const allLocal = store.listLocalMessages("default", agentId);
    expect(allLocal).toHaveLength(12);
    expect(allLocal[0]?.role).toBe("user");
    expect(allLocal.at(-1)?.role).toBe("assistant");

    const ascending = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "asc",
    } as ConversationMessageListBody);
    const userRows = ascending.filter(
      (row) => row.message_type === "user_message",
    );
    expect(userRows).toHaveLength(6);
    expect(userRows[0]?.id).toBe(allLocal[0]?.id);

    // The bounded desc+limit resume tail fetch still reads from disk.
    const tail = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      limit: 2,
    } as ConversationMessageListBody);
    expect(tail.map((row) => row.id)).toEqual(
      ascending
        .slice(-2)
        .reverse()
        .map((row) => row.id),
    );

    // retrieveMessage for a message evicted from the resident window pages
    // through the transcript instead of failing.
    const evictedLocalId = allLocal[0]?.id;
    if (!evictedLocalId) throw new Error("Expected a first message");
    const retrieved = store.retrieveMessage(evictedLocalId);
    expect(retrieved.map((row) => row.id)).toContain(evictedLocalId);
    const evictedAssistantRow = ascending.find(
      (row) => row.message_type === "assistant_message",
    );
    if (!evictedAssistantRow) {
      throw new Error("Expected an assistant row");
    }
    expect(
      store.retrieveMessage(evictedAssistantRow.id).map((row) => row.id),
    ).toEqual([evictedAssistantRow.id]);

    // A fresh store over the same directory sees the identical history.
    const reloaded = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 4,
    });
    expect(reloaded.listLocalMessages("default", agentId)).toEqual(allLocal);
  });

  test("appends without parsing the full transcript", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-append";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 4,
    });
    // One oversized early message pushes the transcript beyond the 64 KB tail
    // window; later turns stay inside the window.
    appendTurn(store, agentId, `bulk-${"x".repeat(96 * 1024)}`);
    for (let turn = 0; turn < 3; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`);
    }

    const messagesPath = conversationMessagesPath(
      storageDir,
      `default:${agentId}`,
    );
    const original = await readFile(messagesPath, "utf8");
    const firstNewline = original.indexOf("\n");
    await writeFile(
      messagesPath,
      `{corrupt-session-header\n${original.slice(firstNewline + 1)}`,
    );

    // The first append in a new session reads only the bounded tail window,
    // so the corrupt transcript head is never parsed.
    const paged = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 4,
    });
    paged.appendTurnInput("default", {
      agent_id: agentId,
      messages: [{ role: "user", content: "after corruption" }],
    } as ConversationMessageCreateBody);
    const tail = paged.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      limit: 1,
    } as ConversationMessageListBody);
    expect(tail[0]).toEqual(
      expect.objectContaining({ message_type: "user_message" }),
    );
    expect(JSON.stringify(tail[0])).toContain("after corruption");

    // Full-history reads still parse the entire file and surface the
    // corruption.
    expect(() => paged.listLocalMessages("default", agentId)).toThrow();
  });

  test("approves and settles tail tool calls after older messages are evicted", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-approval";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 3,
    });
    for (let turn = 0; turn < 4; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`);
    }

    // A pending tool call at the tail (requires_approval stop).
    store.appendStreamChunk("default", agentId, {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "tool-call-evicted-history",
        name: "Bash",
        arguments: "{}",
      },
    } as LettaStreamingResponse);
    store.appendStreamChunk("default", agentId, {
      message_type: "stop_reason",
      stop_reason: "requires_approval",
    });

    // The approval response resolves the pending call even though the earlier
    // turns were evicted from the resident window.
    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [
        {
          type: "approval",
          approvals: [
            {
              type: "tool",
              tool_call_id: "tool-call-evicted-history",
              tool_return: "approved-output",
            },
          ],
        },
      ],
    } as unknown as ConversationMessageCreateBody);
    const afterApproval = store.listLocalMessages("default", agentId);
    const approvalResult = afterApproval.find(
      (message) =>
        message.role === "toolResult" &&
        message.toolCallId === "tool-call-evicted-history",
    );
    expect(approvalResult).toBeDefined();
    expect(JSON.stringify(approvalResult)).toContain("approved-output");

    // A second pending call left unsettled gets a synthetic error result.
    store.appendStreamChunk("default", agentId, {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "tool-call-interrupted",
        name: "Bash",
        arguments: "{}",
      },
    } as LettaStreamingResponse);
    store.appendStreamChunk("default", agentId, {
      message_type: "stop_reason",
      stop_reason: "requires_approval",
    });
    const settled = store.settleInterruptedToolCalls("default", {
      agentId,
      reason: "turn did not complete",
    });
    expect(settled).toBe(1);
    const afterSettle = store.listLocalMessages("default", agentId);
    const settledResult = afterSettle.find(
      (message) =>
        message.role === "toolResult" &&
        message.toolCallId === "tool-call-interrupted",
    );
    expect(settledResult).toBeDefined();
    expect(JSON.stringify(settledResult)).toContain("turn did not complete");

    // A fresh store recovers the full history (both results included) from
    // disk.
    const reloaded = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 3,
    });
    expect(reloaded.listLocalMessages("default", agentId)).toHaveLength(
      afterSettle.length,
    );
  });

  test("conversation record updates never rewrite a partial transcript", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-update";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 2,
    });
    const conversation = store.createConversation({ agent_id: agentId });
    for (let turn = 0; turn < 4; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`, conversation.id);
    }

    store.updateConversation(conversation.id, { summary: "updated" } as never);

    const messagesPath = conversationMessagesPath(
      storageDir,
      `conversation:${conversation.id}`,
    );
    const onDisk = await readFile(messagesPath, "utf8");
    for (let turn = 0; turn < 4; turn += 1) {
      expect(onDisk).toContain(`turn-${turn}`);
      expect(onDisk).toContain(`reply: turn-${turn}`);
    }
    expect(store.listLocalMessages(conversation.id, agentId)).toHaveLength(8);
  });

  test("forks of long conversations page from disk after the rewrite", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-fork";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 3,
    });
    for (let turn = 0; turn < 4; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`);
    }

    const forked = store.forkConversation("default", { agentId });
    expect(store.listLocalMessages(forked.id, agentId)).toHaveLength(8);

    // Appending to the fork keeps the full forked history readable.
    appendTurn(store, agentId, "after-fork", forked.id);
    expect(store.listLocalMessages(forked.id, agentId)).toHaveLength(10);

    const reloaded = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 3,
    });
    expect(reloaded.listLocalMessages(forked.id, agentId)).toHaveLength(10);
  });

  test("in-memory stores keep the full transcript resident", () => {
    const agentId = "agent-local-residency-in-memory";
    const store = new LocalStore(agentId, { residentMessageTailLimit: 2 });
    for (let turn = 0; turn < 4; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`);
    }
    expect(store.listLocalMessages("default", agentId)).toHaveLength(8);
    const firstLocalId = store.listLocalMessages("default", agentId)[0]?.id;
    if (!firstLocalId) throw new Error("Expected a first message");
    expect(store.retrieveMessage(firstLocalId).map((row) => row.id)).toContain(
      firstLocalId,
    );
  });

  test("compact then reload seeds persist maps from the active set", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-compact-reload";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 20,
    });
    for (let turn = 0; turn < 16; turn += 1) {
      appendTurn(store, agentId, `bulk-${turn}-${"x".repeat(4096)}`);
    }
    const beforeCompact = store.listLocalMessages("default", agentId);
    expect(beforeCompact.length).toBeGreaterThan(20);
    const remaining = beforeCompact.slice(-4);
    store.compactConversationAll({
      conversationId: "default",
      agentId,
      summary: "compacted history",
      packedSummary: "compacted history",
      remainingMessages: remaining,
    });

    const reloaded = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 20,
    });
    reloaded.appendTurnInput("default", {
      agent_id: agentId,
      messages: [{ role: "user", content: "after compact reload" }],
    } as ConversationMessageCreateBody);

    const residency = inspectResidency(reloaded, "default", agentId);
    expect(residency.residentMessages).toBeLessThan(10);
    expect(residency.persistedSnapshots).toBe(residency.residentMessages);
    expect(residency.persistedSnapshots).toBeLessThan(beforeCompact.length / 2);
  });

  test("deep desc+before list does not refill the projection index", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-deep-cursor";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 4,
    });
    for (let turn = 0; turn < 20; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`);
    }

    const reloaded = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 4,
    });
    const ascending = reloaded.listConversationMessages("default", {
      agent_id: agentId,
      order: "asc",
    } as ConversationMessageListBody);
    const oldest = ascending[0];
    if (!oldest) throw new Error("Expected an oldest message");
    const beforeDeep = inspectResidency(
      reloaded,
      "default",
      agentId,
    ).projectedIndexSize;

    const page = reloaded.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      before: oldest.id,
      limit: 2,
    } as ConversationMessageListBody);
    expect(page.length).toBeGreaterThan(0);
    expect(
      inspectResidency(reloaded, "default", agentId).projectedIndexSize,
    ).toBe(beforeDeep);
    expect(
      inspectResidency(reloaded, "default", agentId).projectedIndexSize,
    ).toBeLessThan(ascending.length);
  });

  test("fast desc+limit list includes the in-flight assistant", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-in-flight";
    const store = new LocalStore(agentId, {
      storageDir,
      residentMessageTailLimit: 4,
    });
    for (let turn = 0; turn < 3; turn += 1) {
      appendTurn(store, agentId, `turn-${turn}`);
    }
    store.appendStreamChunk("default", agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: "IN_FLIGHT_ASSISTANT" }],
    } as LettaStreamingResponse);

    const local = store.listLocalMessages("default", agentId);
    expect(JSON.stringify(local)).toContain("IN_FLIGHT_ASSISTANT");

    const descending = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      limit: 5,
    } as ConversationMessageListBody);
    expect(JSON.stringify(descending)).toContain("IN_FLIGHT_ASSISTANT");
  });
});

type LocalStoreResidencyMaps = {
  conversationKey: (conversationId: string, agentId: string) => string;
  persistedMessageByMessageIdByConversationKey: Map<
    string,
    Map<string, unknown>
  >;
  messagesById: Map<string, unknown>;
  localMessagesByConversationKey: Map<string, unknown[]>;
};

function inspectResidency(
  store: LocalStore,
  conversationId: string,
  agentId: string,
) {
  const internals = store as unknown as LocalStoreResidencyMaps;
  const key = internals.conversationKey(conversationId, agentId);
  return {
    persistedSnapshots:
      internals.persistedMessageByMessageIdByConversationKey.get(key)?.size ?? 0,
    projectedIndexSize: internals.messagesById.size,
    residentMessages:
      internals.localMessagesByConversationKey.get(key)?.length ?? 0,
  };
}
