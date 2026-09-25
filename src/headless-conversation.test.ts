import { expect, test } from "bun:test";
import { resolveHeadlessConversation } from "./headless-conversation";

const parentTag = "parent-conversation:agent-parent/conv-parent";
const env = {
  LETTA_PARENT_AGENT_ID: "agent-parent",
  LETTA_PARENT_CONVERSATION_ID: "conv-parent",
};

function fixture() {
  const calls: Array<[string, unknown, unknown?]> = [];
  const backend = {
    retrieveConversation: async (id: string) => {
      calls.push(["retrieve", id]);
      return { id };
    },
    createConversation: async (body: unknown) => {
      calls.push(["create", body]);
      return { id: "conv-new" };
    },
    updateConversation: async (id: string, body: unknown) => {
      calls.push(["conversation", id, body]);
      return { id };
    },
    updateAgent: async (id: string, body: unknown) => {
      calls.push(["agent", id, body]);
      return { id };
    },
  } as unknown as Parameters<typeof resolveHeadlessConversation>[0]["backend"];
  return {
    backend,
    calls,
    agent: { id: "agent-child", tags: [] as string[] },
    isSubagent: true,
    isAgentLaunch: true,
    env,
  };
}

test.each(["conv-existing", "conv-forked", "local-conv-existing"])(
  "saves the parent on the resolved named child %s only",
  async (specifiedConversationId) => {
    const f = fixture();
    const result = await resolveHeadlessConversation({
      ...f,
      specifiedConversationId,
    });
    expect(result).toEqual({
      conversationId: specifiedConversationId,
      conversationOpenReason: "resume",
    });
    expect(f.calls).toEqual([
      ["retrieve", specifiedConversationId],
      ["conversation", specifiedConversationId, { tags_to_add: [parentTag] }],
    ]);
  },
);

test("fresh default agents already tagged at creation need no second write", async () => {
  const f = fixture();
  f.agent.tags = [parentTag];
  expect((await resolveHeadlessConversation(f)).conversationId).toBe("default");
  expect(f.calls).toEqual([]);
});

test("named reflection child keeps launch type with its parent link", async () => {
  const f = fixture();
  await resolveHeadlessConversation({
    ...f,
    specifiedConversationId: "conv-reflection",
    env: { ...env, LETTA_SUBAGENT_TYPE: "reflection" },
  });
  expect(f.calls[1]).toEqual([
    "conversation",
    "conv-reflection",
    { tags_to_add: [parentTag, "type:reflection"] },
  ]);
});

test("resumed virtual default writes agent tags without a guessed named scope", async () => {
  const f = fixture();
  await resolveHeadlessConversation({
    ...f,
    specifiedConversationId: "default",
  });
  expect(f.calls).toEqual([
    ["agent", "agent-child", { tags_to_add: [parentTag] }],
  ]);
});

test("new named child is created hidden for an agent sender and then linked", async () => {
  const f = fixture();
  await resolveHeadlessConversation({
    ...f,
    forceNewConversation: true,
    fromAgentId: "agent-parent",
  });
  expect(f.calls).toEqual([
    ["create", { agent_id: "agent-child", hidden: true }],
    ["conversation", "conv-new", { tags_to_add: [parentTag] }],
  ]);
});

test("ephemeral child is linked without retrieving or creating a second scope", async () => {
  const f = fixture();
  await resolveHeadlessConversation({
    ...f,
    ephemeralConversationId: "conv-ephemeral",
  });
  expect(f.calls).toEqual([
    ["conversation", "conv-ephemeral", { tags_to_add: [parentTag] }],
  ]);
});

test("ordinary nested CLI does not reuse inherited launch attribution", async () => {
  const f = fixture();
  await resolveHeadlessConversation({
    ...f,
    isAgentLaunch: false,
    isSubagent: false,
  });
  expect(f.calls).toEqual([["create", { agent_id: "agent-child" }]]);
});

test("scope resolution waits for durable parent write and surfaces its failure", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<never>();
  f.backend.updateAgent = () => gate.promise;
  let resolved = false;
  const pending = resolveHeadlessConversation(f)
    .then(() => {
      resolved = true;
    })
    .catch((error: unknown) => error);
  await Promise.resolve();
  expect(resolved).toBe(false);
  const error = new Error("parent write failed");
  gate.reject(error);
  expect(await pending).toBe(error);
});

test("native local parent scope and default parent scope are preserved literally", async () => {
  for (const parent of ["local-conv-parent", "default"]) {
    const f = fixture();
    await resolveHeadlessConversation({
      ...f,
      env: { ...env, LETTA_PARENT_CONVERSATION_ID: parent },
    });
    expect(f.calls).toEqual([
      [
        "agent",
        "agent-child",
        { tags_to_add: [`parent-conversation:agent-parent/${parent}`] },
      ],
    ]);
  }
});
