import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";

test("worker conversations require an explicit parent without adopting its ownership", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "letta-conversation-store-"));
  const openStore = () =>
    new LocalStore("agent-default", {
      storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });
  try {
    const store = openStore();
    const parent = store.createAgent({ name: "Parent" } as never);
    expect(() =>
      store.createConversation({
        agent_id: null,
        parent_agent_id: "agent-missing",
        model: "openai/gpt-5.5",
        system: "worker system",
      } as never),
    ).toThrow("Agent agent-missing not found");

    const worker = store.createConversation({
      agent_id: null,
      parent_agent_id: parent.id,
      is_subagent: true,
      model: "openai/gpt-5.5",
      system: "worker system",
    } as never);
    expect(readdirSync(join(storageDir, "agents"))).toHaveLength(1);
    expect(() =>
      store.appendTurnInput(worker.id, {
        agent_id: parent.id,
        messages: [{ role: "user", content: "wrong owner" }],
      } as never),
    ).toThrow("Conversation");

    store.appendTurnInput(worker.id, {
      messages: [{ role: "user", content: "hello" }],
    } as never);
    const compacted = store.compactConversationAll({
      conversationId: worker.id,
      agentId: null,
      summary: "summary",
      packedSummary: "summary",
    });
    expect(compacted.summaryMessage.metadata?.agent_id).toBeNull();

    const reopened = openStore();
    expect(reopened.retrieveConversation(worker.id)).toMatchObject({
      agent_id: null,
      parent_agent_id: parent.id,
      system: "worker system",
    });
    expect(
      reopened
        .listConversationMessages(worker.id)
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
