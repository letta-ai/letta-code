import { describe, expect, test } from "bun:test";
import type { ApprovalResponseBody } from "@/types/protocol_v2";
import {
  ChannelControlRequestCoordinator,
  type ChannelControlRequestInboundInput,
} from "./control-request-coordinator";
import type { ChannelControlRequestEvent } from "./types";

function questionEvent(
  overrides: Partial<ChannelControlRequestEvent> = {},
): ChannelControlRequestEvent {
  return {
    requestId: "request-1",
    kind: "ask_user_question",
    source: {
      channel: "slack",
      accountId: "account-1",
      chatId: "channel-1",
      threadId: "thread-1",
      senderId: "user-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          options: [
            { label: "Small fix", description: "Change less" },
            { label: "Refactor", description: "Consolidate ownership" },
          ],
          multiSelect: false,
        },
      ],
    },
    ...overrides,
  };
}

function inbound(
  overrides: Partial<ChannelControlRequestInboundInput> = {},
): ChannelControlRequestInboundInput {
  return {
    channel: "slack",
    accountId: "account-1",
    chatId: "channel-1",
    threadId: "thread-1",
    senderId: "user-1",
    text: "2",
    ...overrides,
  };
}

function createHarness(
  responseResult: "handled" | "expired" | "unavailable" = "handled",
) {
  const prompts: ChannelControlRequestEvent[] = [];
  const reprompts: string[] = [];
  const responses: ApprovalResponseBody[] = [];
  const persisted: ChannelControlRequestEvent[] = [];
  const removed: string[] = [];
  const coordinator = new ChannelControlRequestCoordinator({
    deliverPrompt: async (event) => {
      prompts.push(event);
    },
    deliverReprompt: async (_event, _input, message) => {
      reprompts.push(message);
    },
    deliverResponse: async (_event, response) => {
      responses.push(response);
      return responseResult;
    },
    persist: async (event) => {
      persisted.push(event);
    },
    remove: async (requestId) => {
      removed.push(requestId);
    },
  });
  return { coordinator, prompts, reprompts, responses, persisted, removed };
}

describe("ChannelControlRequestCoordinator", () => {
  test("renders and persists a registered question", async () => {
    const harness = createHarness();
    const event = questionEvent();

    await harness.coordinator.register(event);

    expect(harness.prompts).toEqual([event]);
    expect(harness.persisted).toEqual([event]);
    expect(harness.coordinator.has(event.requestId)).toBe(true);
  });

  test("turns the matching Slack reply into updated question input", async () => {
    const harness = createHarness();
    await harness.coordinator.register(questionEvent());

    expect(await harness.coordinator.tryHandleInbound(inbound())).toBe(true);

    expect(harness.responses).toEqual([
      {
        request_id: "request-1",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: questionEvent().input.questions,
            answers: { "Which approach?": "Refactor" },
          },
        },
      },
    ]);
    expect(harness.removed).toEqual(["request-1"]);
    expect(harness.coordinator.has("request-1")).toBe(false);
  });

  test("keeps a question pending when response delivery is unavailable", async () => {
    const harness = createHarness("unavailable");
    await harness.coordinator.register(questionEvent());

    expect(await harness.coordinator.tryHandleInbound(inbound())).toBe(true);

    expect(harness.coordinator.has("request-1")).toBe(true);
    expect(harness.removed).toEqual([]);
    expect(harness.reprompts[0]).toContain("reconnecting");
  });

  test("does not consume Slack text for generic approvals", async () => {
    const harness = createHarness();
    await harness.coordinator.register(
      questionEvent({ kind: "generic_tool_approval", toolName: "Bash" }),
    );

    expect(await harness.coordinator.tryHandleInbound(inbound())).toBe(false);
    expect(harness.responses).toEqual([]);
  });

  test("replaces an older request in the same channel thread", async () => {
    const harness = createHarness();
    await harness.coordinator.register(questionEvent());
    await harness.coordinator.register(
      questionEvent({ requestId: "request-2" }),
    );

    expect(harness.removed).toEqual(["request-1"]);
    expect(harness.coordinator.has("request-1")).toBe(false);
    expect(harness.coordinator.has("request-2")).toBe(true);
  });
});
