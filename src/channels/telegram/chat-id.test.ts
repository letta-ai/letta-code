import { describe, expect, test } from "bun:test";
import { normalizeTelegramChatId, TELEGRAM_CHAT_ID_ERROR } from "./chat-id";

describe("normalizeTelegramChatId", () => {
  test.each(["7945451305", "-1003904563283", " 7945451305 "])(
    "accepts numeric Telegram Chat ID %s",
    (value) => {
      expect(normalizeTelegramChatId(value)).toBe(value.trim());
    },
  );

  test.each([
    "",
    "Chat ID: 7945451305",
    "https://t.me/example",
    "telegram:7945451305",
  ])("rejects non-numeric Telegram Chat ID %s", (value) => {
    expect(() => normalizeTelegramChatId(value)).toThrow(
      TELEGRAM_CHAT_ID_ERROR,
    );
  });
});
