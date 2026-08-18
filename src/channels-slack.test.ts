import { describe, expect, test } from "bun:test";
import {
  buildSlackModelPickerBlocks,
  collectSlackFiles,
  fetchSlackFile,
  resolveSlackAppMentionIngressPolicy,
  resolveSlackMessageFiles,
  resolveSlackMessageIngressPolicy,
  resolveSlackSelectedModel,
  SLACK_MODEL_SELECT_ACTION_ID,
  stripSlackBotMention,
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

  test("removes only the authenticated bot mention from accepted messages", () => {
    const result = resolveSlackMessageIngressPolicy({
      message: {
        ...mentionedMessage,
        text: "<@U_BOT> <@UALICE> please review",
      },
      botUserId: "U_BOT",
    });

    expect(result).toMatchObject({
      shouldRoute: true,
      text: "<@UALICE> please review",
      routedBy: "mention",
    });
  });

  test("distinguishes DM and ambient thread routing from explicit mentions", () => {
    expect(
      resolveSlackMessageIngressPolicy({
        message: {
          channel: "D123",
          user: "U123",
          text: "hello",
          ts: "100.2",
        },
        botUserId: "UBOT",
      }),
    ).toMatchObject({
      shouldRoute: true,
      routedBy: "dm",
    });
    expect(
      resolveSlackMessageIngressPolicy({
        message: {
          channel: "C123",
          user: "U123",
          text: "continuing with Bob",
          ts: "100.2",
          thread_ts: "100.1",
        },
        botUserId: "UBOT",
        isAgentThread: true,
      }),
    ).toMatchObject({
      shouldRoute: true,
      routedBy: "thread",
    });
  });

  test("preserves semantic bot mentions after the leading routing token", () => {
    const result = resolveSlackAppMentionIngressPolicy({
      event: {
        channel: "C123",
        user: "U123",
        text: "<@UBOT> compare <@UBOT> with <@UALICE>",
        ts: "100.2",
      },
      botUserId: "UBOT",
    });

    expect(result.shouldRoute && result.text).toBe(
      "compare <@UBOT> with <@UALICE>",
    );
  });

  test("normalizes app mentions only after receiving the bot identity", () => {
    const event = {
      channel: "C123",
      user: "U123",
      text: "<@UBOT|letta> <@UALICE|alice> please review",
      ts: "100.2",
    };

    const unresolved = resolveSlackAppMentionIngressPolicy({ event });
    const resolved = resolveSlackAppMentionIngressPolicy({
      event,
      botUserId: "UBOT",
    });

    expect(unresolved.shouldRoute && unresolved.text).toBe(event.text);
    expect(resolved.shouldRoute && resolved.text).toBe(
      "<@UALICE|alice> please review",
    );
  });

  test("exports exact bot stripping without destructive mention guessing", () => {
    expect(stripSlackBotMention("<@UBOT> <@UALICE> hi", "UBOT")).toBe(
      "<@UALICE> hi",
    );
  });
});

describe("public Slack attachment primitives", () => {
  test("exports file normalization, canonical lookup, and secure fetch", () => {
    expect(typeof collectSlackFiles).toBe("function");
    expect(typeof resolveSlackMessageFiles).toBe("function");
    expect(typeof fetchSlackFile).toBe("function");
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
