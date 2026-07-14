import { describe, expect, test } from "bun:test";
import {
  isSlackBotAuthoredInboundMessage,
  isValidSlackAllowBotsConfigValue,
  normalizeSlackAllowBotsMode,
  resolveSlackAllowBotsMode,
  shouldAcceptSlackInboundBotMessage,
} from "./bot-policy";

describe("Slack bot ingress policy", () => {
  test("normalizes only the safe allow-bot subset", () => {
    expect(isValidSlackAllowBotsConfigValue(undefined)).toBe(true);
    expect(isValidSlackAllowBotsConfigValue(false)).toBe(true);
    expect(isValidSlackAllowBotsConfigValue("mentions")).toBe(true);
    expect(isValidSlackAllowBotsConfigValue(true)).toBe(false);
    expect(isValidSlackAllowBotsConfigValue("all")).toBe(false);
    expect(isValidSlackAllowBotsConfigValue("off")).toBe(false);

    expect(normalizeSlackAllowBotsMode(false)).toBe(false);
    expect(normalizeSlackAllowBotsMode("mentions")).toBe("mentions");
    expect(normalizeSlackAllowBotsMode(true)).toBe(false);
    expect(normalizeSlackAllowBotsMode("all")).toBe(false);

    expect(resolveSlackAllowBotsMode(undefined)).toBe("off");
    expect(resolveSlackAllowBotsMode(false)).toBe("off");
    expect(resolveSlackAllowBotsMode("mentions")).toBe("mentions");
  });

  test("accepts human-authored messages regardless of bot ingress mode", () => {
    expect(
      shouldAcceptSlackInboundBotMessage({
        message: { user: "UDEPLOY" },
        allowBots: false,
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: false,
      }),
    ).toBe(true);
  });

  test("unconditionally suppresses own Slack bot user and bot ids", () => {
    expect(
      shouldAcceptSlackInboundBotMessage({
        message: { user: "U0AS42PTEAX", subtype: "bot_message" },
        allowBots: "mentions",
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAcceptSlackInboundBotMessage({
        message: { bot_id: "B0AS42PTEAX", subtype: "bot_message" },
        allowBots: "mentions",
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: true,
      }),
    ).toBe(false);
  });

  test("accepts foreign bots only for explicit mention handoff", () => {
    const foreignBot = { bot_id: "BDEPLOY", subtype: "bot_message" };

    expect(
      shouldAcceptSlackInboundBotMessage({
        message: foreignBot,
        allowBots: undefined,
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAcceptSlackInboundBotMessage({
        message: foreignBot,
        allowBots: false,
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAcceptSlackInboundBotMessage({
        message: foreignBot,
        allowBots: "mentions",
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldAcceptSlackInboundBotMessage({
        message: foreignBot,
        allowBots: "mentions",
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: true,
      }),
    ).toBe(true);
  });

  test("treats bot_message subtype as bot-authored even without bot_id", () => {
    const subtypeOnlyBot = { user: "UDEPLOYBOT", subtype: "bot_message" };

    expect(isSlackBotAuthoredInboundMessage(subtypeOnlyBot)).toBe(true);
    expect(
      shouldAcceptSlackInboundBotMessage({
        message: subtypeOnlyBot,
        allowBots: "mentions",
        botUserId: "U0AS42PTEAX",
        botId: "B0AS42PTEAX",
        wasMentioned: true,
      }),
    ).toBe(true);
  });
});
