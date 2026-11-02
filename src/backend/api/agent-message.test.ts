import { expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client";
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

function lookupBackend(retrieve: () => Promise<unknown>) {
  return {
    retrieveConversation: retrieve,
    createConversation: async () => {
      throw new Error("unexpected conversation creation");
    },
  } as unknown as Backend;
}

function forbidden() {
  return APIError.generate(
    403,
    {
      detail:
        "Other conversations of the same agent can only enqueue a message to the DM itself.",
    },
    undefined,
    new Headers(),
  );
}

test("an unreadable conversation is addressed through the sender's agent", async () => {
  const backend = lookupBackend(async () => {
    throw forbidden();
  });
  expect(
    await resolveAgentMessageDestination(
      { conversationId: TARGET_CONV, senderAgentId: "agent-sender" },
      backend,
    ),
  ).toEqual({ agentId: "agent-sender", conversationId: TARGET_CONV });
});

test("an unreadable conversation keeps an explicit agent_id", async () => {
  const backend = lookupBackend(async () => {
    throw forbidden();
  });
  expect(
    await resolveAgentMessageDestination(
      {
        agentId: "agent-explicit",
        conversationId: TARGET_CONV,
        senderAgentId: "agent-sender",
      },
      backend,
    ),
  ).toEqual({ agentId: "agent-explicit", conversationId: TARGET_CONV });
});

test("an unreadable conversation without any agent still fails", async () => {
  const backend = lookupBackend(async () => {
    throw forbidden();
  });
  await expect(
    resolveAgentMessageDestination({ conversationId: TARGET_CONV }, backend),
  ).rejects.toThrow("403");
});

test.each([
  ["not found", APIError.generate(404, {}, undefined, new Headers())],
  ["network", new Error("socket hang up")],
])("a %s lookup failure still throws", async (_label, failure) => {
  const backend = lookupBackend(async () => {
    throw failure;
  });
  await expect(
    resolveAgentMessageDestination(
      { conversationId: TARGET_CONV, senderAgentId: "agent-sender" },
      backend,
    ),
  ).rejects.toBe(failure);
});

test("a readable conversation of another agent is still rejected", async () => {
  const backend = lookupBackend(async () => ({
    id: TARGET_CONV,
    agent_id: "agent-owner",
  }));
  await expect(
    resolveAgentMessageDestination(
      {
        agentId: "agent-requested",
        conversationId: TARGET_CONV,
        senderAgentId: "agent-sender",
      },
      backend,
    ),
  ).rejects.toThrow("The conversation does not belong to the requested agent.");
});
