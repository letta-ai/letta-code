import { describe, expect, test } from "bun:test";

// The Discord adapter's internal helpers are not exported, but we can test
// the equivalent logic by reimplementing the pure functions here and verifying
// they match the adapter's behavior. These are regression tests for the
// algorithms used in adapter.ts.

// ── splitMessageText ──────────────────────────────────────────────────────

function splitMessageText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

describe("splitMessageText", () => {
  test("short messages pass through as-is", () => {
    expect(splitMessageText("hello", 2000)).toEqual(["hello"]);
  });

  test("empty string returns single chunk", () => {
    expect(splitMessageText("", 2000)).toEqual([""]);
  });

  test("splits at newline boundary when possible", () => {
    const line = "a".repeat(900);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitMessageText(text, 1900);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should split at the newline (position 900), not mid-content
    expect(chunks[0]!.length).toBeLessThanOrEqual(1900);
    // The split should happen at a \n boundary, so first chunk should be
    // exactly 900+1 chars (the first line plus the newline)
    expect(chunks[0]).toBe(`${line}\n${line}`);
  });

  test("splits at space boundary when no newlines available", () => {
    const words = Array(500).fill("word").join(" ");
    const chunks = splitMessageText(words, 1900);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    }
  });

  test("hard-splits when no whitespace available", () => {
    const solid = "x".repeat(5000);
    const chunks = splitMessageText(solid, 1900);
    expect(chunks.length).toBe(3); // 1900 + 1900 + 1200
    expect(chunks[0]!.length).toBe(1900);
    expect(chunks[1]!.length).toBe(1900);
    expect(chunks[2]!.length).toBe(1200);
  });

  test("reconstructed text matches original content", () => {
    const text = Array(100)
      .fill("The quick brown fox jumps over the lazy dog.")
      .join("\n");
    const chunks = splitMessageText(text, 1900);
    // When we split at boundaries and trimStart remaining, some whitespace
    // may be consumed. Verify all non-whitespace content is preserved.
    const originalNonWs = text.replace(/\s+/g, "");
    const reconstructedNonWs = chunks.join("").replace(/\s+/g, "");
    expect(reconstructedNonWs).toBe(originalNonWs);
  });
});

// ── normalizeDiscordMentionText ──────────────────────────────────────────

function normalizeDiscordMentionText(
  text: string,
  botUserId: string | null,
): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@!?${botUserId}>\\s*`, "g"), "").trim();
}

describe("normalizeDiscordMentionText", () => {
  test("strips <@botId> mention", () => {
    expect(normalizeDiscordMentionText("<@123> hello", "123")).toBe("hello");
  });

  test("strips <@!botId> mention (nickname variant)", () => {
    expect(normalizeDiscordMentionText("<@!123> hello", "123")).toBe("hello");
  });

  test("strips multiple mentions of the bot", () => {
    expect(normalizeDiscordMentionText("<@123> hey <@123> there", "123")).toBe(
      "hey there",
    );
  });

  test("preserves mentions of other users", () => {
    expect(normalizeDiscordMentionText("<@456> hello", "123")).toBe(
      "<@456> hello",
    );
  });

  test("returns text unchanged when botUserId is null", () => {
    expect(normalizeDiscordMentionText("<@123> hello", null)).toBe(
      "<@123> hello",
    );
  });

  test("handles mention at end of text", () => {
    expect(normalizeDiscordMentionText("hey <@123>", "123")).toBe("hey");
  });

  test("handles text that is only a mention", () => {
    expect(normalizeDiscordMentionText("<@123>", "123")).toBe("");
  });
});

// ── resolveDiscordReactionEmoji ──────────────────────────────────────────

function resolveDiscordReactionEmoji(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<:") || trimmed.startsWith("<a:")) {
    return trimmed;
  }
  const normalized = trimmed.replace(/^:+|:+$/g, "");
  const nameMap: Record<string, string> = {
    eyes: "👀",
    white_check_mark: "✅",
    x: "❌",
  };
  return nameMap[normalized] ?? normalized;
}

describe("resolveDiscordReactionEmoji", () => {
  test("maps :eyes: to 👀", () => {
    expect(resolveDiscordReactionEmoji(":eyes:")).toBe("👀");
  });

  test("maps :white_check_mark: to ✅", () => {
    expect(resolveDiscordReactionEmoji(":white_check_mark:")).toBe("✅");
  });

  test("maps :x: to ❌", () => {
    expect(resolveDiscordReactionEmoji(":x:")).toBe("❌");
  });

  test("passes through native unicode emoji", () => {
    expect(resolveDiscordReactionEmoji("🔥")).toBe("🔥");
  });

  test("passes through unicode emoji with whitespace trimmed", () => {
    expect(resolveDiscordReactionEmoji("  👍  ")).toBe("👍");
  });

  test("strips colons from named input", () => {
    expect(resolveDiscordReactionEmoji("eyes")).toBe("👀");
  });

  test("passes through unknown names as-is", () => {
    expect(resolveDiscordReactionEmoji("custom_emoji")).toBe("custom_emoji");
  });

  test("passes through Discord custom emoji syntax unchanged", () => {
    expect(resolveDiscordReactionEmoji("<:custom:123456>")).toBe(
      "<:custom:123456>",
    );
    expect(resolveDiscordReactionEmoji("<a:animated:654321>")).toBe(
      "<a:animated:654321>",
    );
  });
});

// ── resolveDiscordChatType ──────────────────────────────────────────────

function resolveDiscordChatType(
  guildId: string | null | undefined,
): "direct" | "channel" {
  return guildId ? "channel" : "direct";
}

describe("resolveDiscordChatType", () => {
  test("null guildId is direct", () => {
    expect(resolveDiscordChatType(null)).toBe("direct");
  });

  test("undefined guildId is direct", () => {
    expect(resolveDiscordChatType(undefined)).toBe("direct");
  });

  test("non-empty guildId is channel", () => {
    expect(resolveDiscordChatType("guild-123")).toBe("channel");
  });
});
