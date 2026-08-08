import { describe, expect, test } from "bun:test";
import {
  hasExplicitDiscordUserMention,
  isValidDiscordAllowBotsConfigValue,
  normalizeDiscordAllowBotsMode,
  shouldAcceptDiscordInboundBotMessage,
} from "./bot-policy";

describe("Discord bot ingress policy", () => {
  test("normalizes and validates the allow_bots protocol value", () => {
    expect(isValidDiscordAllowBotsConfigValue(undefined)).toBe(true);
    expect(isValidDiscordAllowBotsConfigValue(false)).toBe(true);
    expect(isValidDiscordAllowBotsConfigValue("mentions")).toBe(true);
    expect(isValidDiscordAllowBotsConfigValue(true)).toBe(false);
    expect(isValidDiscordAllowBotsConfigValue("all")).toBe(false);
    expect(isValidDiscordAllowBotsConfigValue("true")).toBe(false);

    expect(normalizeDiscordAllowBotsMode(undefined)).toBe(false);
    expect(normalizeDiscordAllowBotsMode(false)).toBe(false);
    expect(normalizeDiscordAllowBotsMode("mentions")).toBe("mentions");
  });

  test("matches only real mention markup for the receiving bot user id", () => {
    expect(
      hasExplicitDiscordUserMention({ content: "hey <@bot-user>" }, "bot-user"),
    ).toBe(true);
    expect(
      hasExplicitDiscordUserMention(
        { content: "hey <@!bot-user>" },
        "bot-user",
      ),
    ).toBe(true);
    expect(
      hasExplicitDiscordUserMention(
        { content: "reply-ping metadata only" },
        "bot-user",
      ),
    ).toBe(false);
    expect(
      hasExplicitDiscordUserMention(
        { content: "hey <@other-bot>" },
        "bot-user",
      ),
    ).toBe(false);
  });

  test("keeps humans, suppresses self, and only admits foreign bots on explicit mentions", () => {
    expect(
      shouldAcceptDiscordInboundBotMessage({
        message: { author: { id: "human", bot: false }, content: "ambient" },
        allowBots: false,
        botUserId: "bot-user",
        wasExplicitlyMentioned: false,
      }),
    ).toBe(true);

    expect(
      shouldAcceptDiscordInboundBotMessage({
        message: {
          author: { id: "bot-user", bot: true },
          content: "<@bot-user>",
        },
        allowBots: "mentions",
        botUserId: "bot-user",
        wasExplicitlyMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAcceptDiscordInboundBotMessage({
        message: {
          author: { id: "foreign-bot", bot: true },
          content: "<@bot-user>",
        },
        allowBots: false,
        botUserId: "bot-user",
        wasExplicitlyMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAcceptDiscordInboundBotMessage({
        message: {
          author: { id: "foreign-bot", bot: true },
          content: "metadata",
        },
        allowBots: "mentions",
        botUserId: "bot-user",
        wasExplicitlyMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldAcceptDiscordInboundBotMessage({
        message: {
          author: { id: "foreign-bot", bot: true },
          content: "<@bot-user>",
        },
        allowBots: "mentions",
        botUserId: "bot-user",
        wasExplicitlyMentioned: true,
      }),
    ).toBe(true);
  });
});
