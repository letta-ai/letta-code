import { expect, mock, test } from "bun:test";
import type { Backend } from "./backend";
import {
  getConversationExecutionAgentId,
  retrieveConversationAgent,
} from "./conversation-identity";

test("attached agents take precedence over inherited configuration", () => {
  expect(
    getConversationExecutionAgentId({
      agent_id: "agent-own",
      created_by_agent_id: "agent-parent",
    }),
  ).toBe("agent-own");
  expect(
    getConversationExecutionAgentId({
      agent_id: null,
      created_by_agent_id: "agent-parent",
    }),
  ).toBe("agent-parent");
  expect(getConversationExecutionAgentId({ agent_id: null })).toBeNull();
});

test("resuming a named ephemeral child loads parent tools without changing its name", async () => {
  const parent = {
    id: "agent-parent",
    name: "Parent",
    tools: [{ name: "Read" }],
  };
  const retrieveAgent = mock(async () => parent);
  const backend = {
    retrieveConversation: async () => ({
      id: "conv-child",
      agent_id: null,
      created_by_agent_id: parent.id,
      name: "Joi (subagent)",
      is_subagent: true,
    }),
    retrieveAgent,
  } as unknown as Backend;
  expect(await retrieveConversationAgent("conv-child", backend)).toMatchObject({
    ...parent,
    name: "Joi (subagent)",
  });
  expect(parent.name).toBe("Parent");
  expect(retrieveAgent).toHaveBeenCalledWith(parent.id, {
    include: ["agent.tools", "agent.tags"],
  });
  await expect(
    retrieveConversationAgent("conv-child", backend, "agent-other"),
  ).rejects.toThrow("does not belong");
  expect(retrieveAgent).toHaveBeenCalledTimes(1);
});

test("standalone ephemeral conversations cannot acquire an arbitrary agent's permissions", async () => {
  const retrieveAgent = mock(async () => ({}));
  const backend = {
    retrieveConversation: async () => ({ id: "conv-child", agent_id: null }),
    retrieveAgent,
  } as unknown as Backend;
  await expect(
    retrieveConversationAgent("conv-child", backend),
  ).rejects.toThrow("no creating agent");
  expect(retrieveAgent).not.toHaveBeenCalled();
});
