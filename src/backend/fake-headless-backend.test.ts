import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DeterministicToolCallExecutor } from "@/backend/dev/headless-turn-executor";
import { TURN_DID_NOT_COMPLETE } from "@/constants";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("FakeHeadlessBackend", () => {
  test("streams deterministic assistant responses", async () => {
    const backend = new FakeHeadlessBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "ping" }],
      } as ConversationMessageCreateBody),
    );

    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["assistant_message", "stop_reason"]);
    expect(JSON.stringify(chunks)).toContain("pong");
  });

  test("persists pi-style local transcripts when storage is enabled", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-pi-"));
    const backend = new FakeHeadlessBackend("agent-fake-headless", undefined, {
      storageDir,
      strictAgentAccess: false,
      strictConversationAccess: false,
    });
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "persist" }],
      } as ConversationMessageCreateBody),
    );

    const conversationsDir = join(storageDir, "conversations");
    const dirs = await readdir(conversationsDir);
    let conversationDir: string | undefined;
    for (const dir of dirs) {
      const candidateDir = join(conversationsDir, dir);
      const candidate = JSON.parse(
        await readFile(join(candidateDir, "conversation.json"), "utf8"),
      ) as { id?: unknown };
      if (candidate.id === conversation.id) {
        conversationDir = candidateDir;
        break;
      }
    }
    if (!conversationDir)
      throw new Error("Expected the persisted test conversation directory");
    const manifest = JSON.parse(
      await readFile(join(conversationDir, "manifest.json"), "utf8"),
    );
    expect(manifest.provider_stack).toBe("pi-ai");
    const jsonl = await readFile(
      join(conversationDir, "messages.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain('"content"');
    expect(jsonl).not.toContain('"parts"');
  });

  test("settles orphaned tool calls from an interrupted turn before the next turn", async () => {
    // Simulate what happens when a turn is interrupted (crash / unhandled error)
    // before cancelConversation is called: a tool_use block is stored in the
    // conversation history but its tool_result never arrives. The next turn must
    // add a synthetic error result so the provider doesn't reject the context.
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new DeterministicToolCallExecutor(),
      { strictAgentAccess: false, strictConversationAccess: false },
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    // Run a turn that ends with a tool call (requires_approval), then do NOT
    // send a tool result — leave the tool call orphaned.
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "use a tool" }],
      } as ConversationMessageCreateBody),
    );

    // Inspect the raw local messages before the next turn: there should be one
    // tool call with no corresponding result.
    const storeBefore = (
      backend as unknown as {
        store: { listLocalMessages: (id: string) => unknown[] };
      }
    ).store.listLocalMessages(conversation.id);
    const messagesBefore = storeBefore as Array<{
      role: string;
      content?: Array<{ type: string; id?: string }>;
      toolCallId?: string;
    }>;
    const orphanedCallIds = messagesBefore
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((c) => c.type === "toolCall")
      .map((c) => c.id ?? "");
    const existingResultIds = messagesBefore
      .filter((m) => m.role === "toolResult")
      .map((m) => m.toolCallId ?? "");
    const unsettled = orphanedCallIds.filter(
      (id) => !existingResultIds.includes(id),
    );
    expect(unsettled.length).toBe(1); // one orphaned tool call before the next turn

    // Start the next turn — executeConversationTurn should settle the orphan first.
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "second turn" }],
      } as ConversationMessageCreateBody),
    );

    // Now the orphaned tool call should have a synthetic error result.
    const storeAfter = (
      backend as unknown as {
        store: { listLocalMessages: (id: string) => unknown[] };
      }
    ).store.listLocalMessages(conversation.id);
    const messagesAfter = storeAfter as Array<{
      role: string;
      content?: Array<{ type: string; text?: string }>;
      toolCallId?: string;
    }>;
    const settledResult = messagesAfter.find(
      (m) =>
        m.role === "toolResult" &&
        unsettled.includes(m.toolCallId ?? "") &&
        m.content?.some((c) => c.text === TURN_DID_NOT_COMPLETE),
    );
    expect(settledResult).toBeDefined();
  });

  test("keeps approval turns open when a tool call is emitted", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new DeterministicToolCallExecutor(),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "use a tool" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["approval_request_message", "stop_reason"]);
    expect(
      (chunks.at(-1) as { stop_reason?: string } | undefined)?.stop_reason,
    ).toBe("requires_approval");
  });
});
