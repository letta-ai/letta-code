const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;

export const TELEGRAM_CHAT_ID_ERROR =
  "Invalid Telegram Chat ID. Paste only the numeric Telegram Chat ID, for example 7945451305 or -1003904563283.";

export function normalizeTelegramChatId(value: string): string {
  const chatId = value.trim();
  if (!TELEGRAM_CHAT_ID_PATTERN.test(chatId)) {
    throw new Error(TELEGRAM_CHAT_ID_ERROR);
  }
  return chatId;
}
