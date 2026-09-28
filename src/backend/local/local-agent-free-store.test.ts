import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";

test("agent-free conversations retain explicit null owner and parent through transcript reload", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "letta-agent-free-store-"));
  try {
    const store = new LocalStore("agent-default", {
      storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });
    const parent = store.createAgent({ name: "Parent" } as never);
    const agentCount = readdirSync(join(storageDir, "agents")).length;
    expect(() =>
      store.createConversation({
        agent_id: null,
        parent_agent_id: "agent-missing",
        model: "openai/gpt-5.5",
        system: "worker system",
      } as never),
    ).toThrow("Agent agent-missing not found");
    const created = store.createConversation({
      agent_id: null,
      parent_agent_id: parent.id,
      is_subagent: true,
      name: "Workflow worker",
      model: "openai/gpt-5.5",
      system: "worker system",
    } as never);
    expect(created).toMatchObject({
      agent_id: null,
      parent_agent_id: parent.id,
      is_subagent: true,
      name: "Workflow worker",
      system: "worker system",
    });
    expect(readdirSync(join(storageDir, "agents"))).toHaveLength(agentCount);
    expect(store.resolveAgentIdForConversation(created.id)).toBeNull();
    expect(
      store.appendTurnInput(created.id, {
        messages: [{ role: "user", content: "hello" }],
      } as never),
    ).toEqual({ agentId: null, conversationId: created.id });
    store.appendStreamChunk(created.id, null, {
      message_type: "assistant_message",
      content: [{ type: "text", text: "done" }],
    } as never);
    store.appendStreamChunk(created.id, null, {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    } as never);

    const reloaded = new LocalStore("agent-default", {
      storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });
    expect(reloaded.retrieveConversation(created.id)).toMatchObject({
      agent_id: null,
      parent_agent_id: parent.id,
      system: "worker system",
    });
    expect(reloaded.listConversations()).toContainEqual(
      expect.objectContaining({ id: created.id, agent_id: null }),
    );
    const messages = reloaded.listConversationMessages(created.id, {
      order: "asc",
    });
    expect(messages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(messages.every((message) => message.agent_id === null)).toBe(true);
    const firstMessage = messages[0];
    if (!firstMessage) throw new Error("Missing persisted message");
    expect(reloaded.retrieveMessage(firstMessage.id)[0]?.agent_id).toBeNull();
    expect(readdirSync(join(storageDir, "agents"))).toHaveLength(agentCount);

    const conversationDir = readdirSync(join(storageDir, "conversations"))
      .map((item) => join(storageDir, "conversations", item))
      .find((dir) => {
        const record = JSON.parse(
          readFileSync(join(dir, "conversation.json"), "utf8"),
        );
        return record.id === created.id;
      });
    expect(conversationDir).toBeDefined();
    if (!conversationDir) throw new Error("Missing persisted conversation");
    expect(
      JSON.parse(
        readFileSync(join(conversationDir, "conversation.json"), "utf8"),
      ),
    ).toMatchObject({ agent_id: null, parent_agent_id: parent.id });

    expect(() =>
      reloaded.appendTurnInput(created.id, {
        agent_id: parent.id,
        messages: [{ role: "user", content: "wrong owner" }],
      } as never),
    ).toThrow("Conversation");
    const compacted = reloaded.compactConversationAll({
      conversationId: created.id,
      agentId: null,
      summary: "summary",
      packedSummary: "summary",
    });
    expect(compacted.summaryMessage.metadata?.agent_id).toBeNull();
    const reloadedAgain = new LocalStore("agent-default", {
      storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });
    expect(
      reloadedAgain
        .listConversationMessages(created.id)
        .some(
          (message) =>
            message.message_type === "summary_message" &&
            message.agent_id === null,
        ),
    ).toBe(true);
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});
