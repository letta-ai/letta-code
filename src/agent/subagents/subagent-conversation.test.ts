import { expect, test } from "bun:test";
import { createSubagentConversation } from "./subagent-conversation";

test("Cloud children create persisted ancestry before startup", async () => {
  const calls: unknown[] = [];
  const id = await createSubagentConversation(
    true,
    "conv-parent",
    "agent-child",
    async (body) => {
      calls.push(body);
      return { id: "conv-child" };
    },
  );
  expect(id).toBe("conv-child");
  expect(calls).toEqual([
    {
      agent_id: "agent-child",
      parent_conversation_id: "conv-parent",
      is_subagent: true,
    },
  ]);
});

test.each([
  [false, "conv-parent"],
  [true, undefined],
  [true, ""],
  [true, "default"],
] as const)("%s with parent %s keeps default history", async (mode, parent) => {
  const id = await createSubagentConversation(
    mode,
    parent,
    "agent-child",
    async () => {
      throw new Error("must not create");
    },
  );
  expect(id).toBe("default");
});

test("creation errors stop launch instead of falling back to default", async () => {
  await expect(
    createSubagentConversation(true, "conv-parent", "agent-child", async () => {
      throw new Error("denied");
    }),
  ).rejects.toThrow("denied");
});
