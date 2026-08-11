import { describe, expect, test } from "bun:test";
import {
  buildSlackModelPickerBlocks,
  resolveSlackMessageIngressPolicy,
  resolveSlackSelectedModel,
  SLACK_MODEL_SELECT_ACTION_ID,
} from "@/channels-slack";

describe("public Slack message ingress policy", () => {
  const mentionedMessage = {
    channel: "C123",
    user: "U123",
    text: "<@U_BOT> /model",
    ts: "100.2",
    thread_ts: "100.1",
  };

  test("lets app_mention own mentioned channel messages", () => {
    expect(
      resolveSlackMessageIngressPolicy({
        message: mentionedMessage,
        botUserId: "U_BOT",
        appMentionEventWillHandleMentions: true,
      }),
    ).toEqual({ shouldRoute: false, reason: "handled_by_app_mention" });
  });

  test("keeps the message event when app_mention is not handling it", () => {
    expect(
      resolveSlackMessageIngressPolicy({
        message: mentionedMessage,
        botUserId: "U_BOT",
      }).shouldRoute,
    ).toBe(true);
  });

  test("keeps ordinary thread follow-ups when app_mention handles mentions", () => {
    expect(
      resolveSlackMessageIngressPolicy({
        message: { ...mentionedMessage, text: "keep going" },
        botUserId: "U_BOT",
        appMentionEventWillHandleMentions: true,
      }).shouldRoute,
    ).toBe(true);
  });

  test("keeps direct messages when app_mention handles channel mentions", () => {
    expect(
      resolveSlackMessageIngressPolicy({
        message: { ...mentionedMessage, channel: "D123", thread_ts: undefined },
        botUserId: "U_BOT",
        appMentionEventWillHandleMentions: true,
      }).shouldRoute,
    ).toBe(true);
  });
});

describe("public Slack model picker", () => {
  test("exports the shared picker blocks and action contract", () => {
    const blocks = buildSlackModelPickerBlocks({
      current: {
        modelLabel: "Auto",
        modelHandle: "letta/auto",
        scope: "conversation",
      },
      entries: [
        {
          id: "auto",
          handle: "letta/auto",
          label: "Auto",
          description: "Recommended default",
          isDefault: true,
        },
      ],
      availableHandles: ["letta/auto"],
      recentHandles: [],
    });

    expect(blocks).toContainEqual({
      type: "actions",
      elements: [
        expect.objectContaining({
          type: "static_select",
          action_id: SLACK_MODEL_SELECT_ACTION_ID,
        }),
      ],
    });
    expect(
      resolveSlackSelectedModel(undefined, {
        actions: [{ selected_option: { value: "letta/auto" } }],
      }),
    ).toBe("letta/auto");
  });
});
