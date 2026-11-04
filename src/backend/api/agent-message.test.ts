import { expect, test } from "bun:test";
import type { Backend } from "@/backend";
import {
  normalizeAgentMessageComputer,
  resolveAgentMessageDestination,
} from "./agent-message";

test.each([
  ["agent-current", "conv-current", "agent-current", "conv-current", true],
  ["agent-current", "default", "agent-current", "default", true],
  ["agent-other", "default", "agent-current", "default", false],
  ["agent-current", "conv-fork", "agent-current", "conv-current", false],
  ["agent-current", "default", "agent-current", "conv-current", false],
  ["agent-current", undefined, "agent-current", "conv-current", false],
])(
  "resolved destination %s/%s compared with runtime %s/%s",
  async (
    agentId,
    conversationId,
    currentAgentId,
    currentConversationId,
    reject,
  ) => {
    let creations = 0;
    const backend = {
      retrieveConversation: async (id: string) => ({ id, agent_id: agentId }),
      createConversation: async () => {
        creations++;
        return { id: "conv-new" };
      },
    } as unknown as Backend;
    const result = resolveAgentMessageDestination(
      {
        agentId,
        conversationId,
        senderAgentId: "agent-overridden",
        currentConversation: {
          agentId: currentAgentId,
          conversationId: currentConversationId,
        },
      },
      backend,
    );
    if (reject) {
      await expect(result).rejects.toThrow(
        "Cannot message the current conversation",
      );
    } else {
      expect(await result).toEqual({
        agentId,
        conversationId: conversationId ?? "conv-new",
      });
    }
    expect(creations).toBe(conversationId ? 0 : 1);
  },
);

test.each([undefined, null, "", " \t\n"])(
  "an unset optional computer uses the existing destination: %j",
  (value) => {
    expect(normalizeAgentMessageComputer(value)).toBeUndefined();
  },
);

test.each([
  ["cloud", "cloud"],
  [" Cloud-Sandbox ", "cloud"],
  [" My laptop ", "My laptop"],
  ["device-123", "device-123"],
])("normalizes %s to %s", (input, expected) => {
  expect(normalizeAgentMessageComputer(input)).toBe(expected);
});

test.each([{ value: false }, { value: 0 }, { value: [] }, { value: {} }])(
  "rejects an invalid computer value %j",
  ({ value }) => {
    expect(() => normalizeAgentMessageComputer(value)).toThrow(
      "computer must be a computer name, or omitted",
    );
  },
);

const TARGET_CONV = "conv-33333333-3333-4333-8333-333333333333";

function recordingBackend(conversationAgentId?: string) {
  const reads: string[] = [];
  const created: unknown[] = [];
  const backend = {
    retrieveConversation: async (id: string) => {
      reads.push(id);
      if (!conversationAgentId) {
        throw Object.assign(new Error("403 Forbidden"), { status: 403 });
      }
      return { id, agent_id: conversationAgentId };
    },
    createConversation: async (body: unknown) => {
      created.push(body);
      return { id: "conv-created" };
    },
  } as unknown as Backend;
  return { backend, reads, created };
}

test("a conversation ID alone is a destination and is never read", async () => {
  const f = recordingBackend("agent-owner");
  const destination = await resolveAgentMessageDestination(
    { conversationId: TARGET_CONV, senderAgentId: "agent-sender" },
    f.backend,
  );
  expect(destination).toEqual({ conversationId: TARGET_CONV });
  expect(f.reads).toEqual([]);
  expect(f.created).toEqual([]);
});

test("an explicit agent_id is passed through for an unreadable conversation", async () => {
  const f = recordingBackend();
  expect(
    await resolveAgentMessageDestination(
      { agentId: "agent-explicit", conversationId: TARGET_CONV },
      f.backend,
    ),
  ).toEqual({ agentId: "agent-explicit", conversationId: TARGET_CONV });
  expect(f.reads).toEqual([]);
});

test("an explicit agent_id with a conversation is forwarded without a read", async () => {
  // The server reports the conversation's real agent in the enqueue receipt.
  const f = recordingBackend("agent-owner");
  expect(
    await resolveAgentMessageDestination(
      { agentId: "agent-requested", conversationId: TARGET_CONV },
      f.backend,
    ),
  ).toEqual({ agentId: "agent-requested", conversationId: TARGET_CONV });
  expect(f.reads).toEqual([]);
});

test("the default conversation still requires agent_id", async () => {
  const f = recordingBackend("agent-owner");
  await expect(
    resolveAgentMessageDestination(
      { conversationId: "default", senderAgentId: "agent-sender" },
      f.backend,
    ),
  ).rejects.toThrow("The default conversation requires agent_id.");
  expect(
    await resolveAgentMessageDestination(
      { agentId: "agent-target", conversationId: "default" },
      f.backend,
    ),
  ).toEqual({ agentId: "agent-target", conversationId: "default" });
  expect(f.reads).toEqual([]);
});

test("an agent-only send creates a conversation for that agent", async () => {
  const f = recordingBackend();
  expect(
    await resolveAgentMessageDestination(
      { agentId: "agent-target", senderAgentId: "agent-sender" },
      f.backend,
    ),
  ).toEqual({ agentId: "agent-target", conversationId: "conv-created" });
  expect(f.created).toEqual([{ agent_id: "agent-target", hidden: true }]);
});

test.each([
  [{ conversationId: TARGET_CONV }, { conversationId: TARGET_CONV }],
  [
    { conversationId: TARGET_CONV },
    { agentId: "agent-self", conversationId: TARGET_CONV },
  ],
  [
    { agentId: "agent-self", conversationId: "default" },
    { agentId: "agent-self", conversationId: "default" },
  ],
])(
  "refuses to message the current conversation: %j",
  async (target, current) => {
    const f = recordingBackend();
    await expect(
      resolveAgentMessageDestination(
        { ...target, currentConversation: current },
        f.backend,
      ),
    ).rejects.toThrow("Cannot message the current conversation.");
    expect(f.reads).toEqual([]);
  },
);

test("another agent's default conversation is not the current one", async () => {
  const f = recordingBackend();
  expect(
    await resolveAgentMessageDestination(
      {
        agentId: "agent-other",
        conversationId: "default",
        currentConversation: {
          agentId: "agent-self",
          conversationId: "default",
        },
      },
      f.backend,
    ),
  ).toEqual({ agentId: "agent-other", conversationId: "default" });
});
