import { expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client";
import { ApiRequestError } from "@/backend/api/request";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  caller,
  sendAgentMessageFixture as fixture,
  message,
  TARGET_CONV,
} from "@/test-utils/send-agent-message-fixture";
import {
  AGENT_SEND_RECEIPT_NOTE,
  send_agent_message,
} from "./send-agent-message";

// The enqueue receipt names the conversation's agent; it drives the reported
// agent, the recovery hints, and child-subagent tracking.

test("an accepted send tells the sender not to end its turn waiting on a reply", async () => {
  const f = fixture([], "agent-target");
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, f),
  );
  expect(result.status).toBe("success");
  expect(JSON.parse(result.content).note).toBe(AGENT_SEND_RECEIPT_NOTE);
});

test("a failed send carries no reply note", async () => {
  const f = fixture([], "agent-target");
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, {
      ...f,
      enqueue: async () => {
        throw new ApiRequestError("refused", 409, "refused");
      },
    }),
  );
  expect(result.status).toBe("error");
  expect(JSON.parse(result.content).note).toBeUndefined();
});

test("a conversation-ID send reports the agent from the server's receipt", async () => {
  const f = fixture([], "agent-target");
  f.backend.retrieveConversation = async () => {
    throw new Error("a conversation-ID send must not read the conversation");
  };
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, f),
  );
  expect(result.status).toBe("success");
  expect(f.submissions[0]?.agentId).toBeUndefined();
  expect(JSON.parse(result.content)).toMatchObject({
    status: "queued",
    agent_id: "agent-target",
    conversation_id: TARGET_CONV,
    status_command: `letta messages status --agent agent-target --conversation ${TARGET_CONV}`,
    messages_command: `letta messages list --agent agent-target --conversation ${TARGET_CONV}`,
  });
});

test("a conversation-ID send to this agent's own subagent is tracked via the receipt agent", async () => {
  const f = fixture(
    ["type:code-reviewer", "parent:agent-caller"],
    "agent-target",
  );
  const order: string[] = [];
  const retrieveAgent = f.backend.retrieveAgent;
  f.backend.retrieveAgent = async (id, options) => {
    order.push(`lookup:${id}`);
    return retrieveAgent(id, options);
  };
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, {
      ...f,
      enqueue: async (input) => {
        order.push("enqueue");
        return f.enqueue(input);
      },
    }),
  );
  expect(result.status).toBe("success");
  // The child is identified from the receipt, so the lookup follows the enqueue.
  expect(order).toEqual(["enqueue", "lookup:agent-target"]);
  expect(f.tracked).toHaveLength(1);
  expect(f.tracked[0]).toMatchObject({
    receipt: { agent_id: "agent-target", super_run_id: "sr-1" },
    child: { name: "Hayt", type: "code-reviewer" },
    parentScope: { agentId: "agent-caller", conversationId: "conv-caller" },
  });
});

test("an explicit agent_id with a conversation is forwarded; the server's receipt agent wins", async () => {
  const f = fixture([], "agent-target");
  f.backend.retrieveConversation = async () => {
    throw new Error("a conversation-ID send must not read the conversation");
  };
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message({ ...message, agent_id: "agent-wrong" }, f),
  );
  expect(f.submissions[0]?.agentId).toBe("agent-wrong");
  expect(JSON.parse(result.content).agent_id).toBe("agent-target");
});

test("an older server without a receipt agent_id reports null and skips tracking", async () => {
  const f = fixture(["parent:agent-caller"]);
  const reads: string[] = [];
  f.backend.retrieveConversation = async (id) => {
    reads.push(`conversation:${id}`);
    throw APIError.generate(403, {}, undefined, new Headers());
  };
  f.backend.retrieveAgent = async (id) => {
    reads.push(`agent:${id}`);
    throw new Error("unexpected agent read");
  };
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, f),
  );
  expect(result.status).toBe("success");
  expect(reads).toEqual([]);
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]?.conversationId).toBe(TARGET_CONV);
  expect(f.submissions[0]?.agentId).toBeUndefined();
  expect(f.tracked).toHaveLength(0);
  expect(JSON.parse(result.content)).toMatchObject({
    status: "queued",
    agent_id: null,
    conversation_id: TARGET_CONV,
    status_command: `letta messages status --conversation ${TARGET_CONV}`,
    messages_command: `letta messages list --conversation ${TARGET_CONV}`,
  });
});

const childMessage = { ...message, agent_id: "agent-target" };

test("a send to this agent's own subagent is tracked against the receipt", async () => {
  const f = fixture(["type:code-reviewer", "parent:agent-caller"]);
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(childMessage, f),
  );
  expect(result.status).toBe("success");
  expect(f.tracked).toHaveLength(1);
  expect(f.tracked[0]).toMatchObject({
    receipt: { agent_id: "agent-target", super_run_id: "sr-1" },
    child: { name: "Hayt", type: "code-reviewer" },
    prompt: message.message,
    parentScope: { agentId: "agent-caller", conversationId: "conv-caller" },
  });
});

test.each([
  { tags: [] },
  { tags: ["type:general-purpose", "parent:agent-someone-else"] },
])(
  "a send to a peer agent is never tracked as a subagent: %j",
  async ({ tags }) => {
    const f = fixture(tags);
    const result = await runWithRuntimeContext(caller, () =>
      send_agent_message(childMessage, f),
    );
    expect(result.status).toBe("success");
    expect(f.submissions).toHaveLength(1);
    expect(f.tracked).toHaveLength(0);
  },
);

test("a failed child lookup still delivers and skips tracking", async () => {
  const f = fixture(["parent:agent-caller"]);
  f.backend.retrieveAgent = async () => {
    throw new ApiRequestError("gone", 404, "gone");
  };
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(childMessage, f),
  );
  expect(result.status).toBe("success");
  expect(f.submissions).toHaveLength(1);
  expect(f.tracked).toHaveLength(0);
});

test("a rejected enqueue to a child is not tracked", async () => {
  const f = fixture(["parent:agent-caller"]);
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(childMessage, {
      ...f,
      enqueue: async () => {
        throw new ApiRequestError("refused", 403, "refused");
      },
    }),
  );
  expect(result.status).toBe("error");
  expect(f.tracked).toHaveLength(0);
});
