import { expect, spyOn, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { rebuildInputForApprovalResync } from "./approval-recovery";

test.each(["conv-child", null])(
  "approval resync reads conversation state for ephemeral agent ID %s",
  async (agentId) => {
    const backend = new FakeHeadlessBackend("agent-parent");
    const conversation = spyOn(
      backend,
      "retrieveConversation",
    ).mockResolvedValue({
      id: "conv-child",
      agent_id: null,
      model: "anthropic/claude-sonnet-4-6",
      in_context_message_ids: [],
    } as never);
    const agent = spyOn(backend, "retrieveAgent");
    __testSetBackend(backend);
    try {
      const input = [{ role: "user" as const, content: "continue" }];
      expect(
        await rebuildInputForApprovalResync(agentId, "conv-child", input),
      ).toMatchObject(input);
      expect(conversation).toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
    } finally {
      conversation.mockRestore();
      agent.mockRestore();
      __testSetBackend(null);
    }
  },
);
