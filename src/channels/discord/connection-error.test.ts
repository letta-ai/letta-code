import { describe, expect, test } from "bun:test";
import {
  DISCORD_DISALLOWED_INTENTS_MESSAGE,
  describeDiscordConnectionError,
  isDiscordDisallowedIntentsError,
} from "@/channels/discord/connection-error";

describe("isDiscordDisallowedIntentsError", () => {
  test("matches the raw gateway close reason", () => {
    expect(
      isDiscordDisallowedIntentsError(new Error("Used disallowed intents")),
    ).toBe(true);
  });

  test("matches the discord.js error code", () => {
    const error = Object.assign(new Error("nope"), {
      code: "DisallowedIntents",
    });
    expect(isDiscordDisallowedIntentsError(error)).toBe(true);
  });

  test("matches the numeric gateway close code 4014", () => {
    const error = Object.assign(new Error("Connection closed"), {
      code: 4014,
    });
    expect(isDiscordDisallowedIntentsError(error)).toBe(true);
  });

  test("matches a 'Privileged intent' phrasing", () => {
    expect(
      isDiscordDisallowedIntentsError(
        new Error("Privileged intent provided is not enabled or whitelisted."),
      ),
    ).toBe(true);
  });

  test("matches plain string errors", () => {
    expect(isDiscordDisallowedIntentsError("used Disallowed Intent(s)")).toBe(
      true,
    );
  });

  test("ignores unrelated errors", () => {
    expect(
      isDiscordDisallowedIntentsError(new Error("Invalid token provided")),
    ).toBe(false);
    expect(isDiscordDisallowedIntentsError(undefined)).toBe(false);
    expect(isDiscordDisallowedIntentsError(null)).toBe(false);
    expect(isDiscordDisallowedIntentsError({})).toBe(false);
  });
});

describe("describeDiscordConnectionError", () => {
  test("returns the actionable message for disallowed-intents errors", () => {
    const message = describeDiscordConnectionError(
      new Error("Used disallowed intents"),
    );
    expect(message).toBe(DISCORD_DISALLOWED_INTENTS_MESSAGE);
    expect(message).toContain("Message Content Intent");
    expect(message).toContain("Privileged Gateway Intents");
  });

  test("returns null for unrecognized errors", () => {
    expect(
      describeDiscordConnectionError(new Error("Invalid token provided")),
    ).toBeNull();
  });
});
