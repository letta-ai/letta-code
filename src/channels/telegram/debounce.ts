import type { TelegramChannelAccount } from "@/channels/types";

const TELEGRAM_DEBOUNCE_DEFAULT_MS = 0;
const TELEGRAM_DEBOUNCE_MAX_MS = 10000;

export function resolveTelegramInboundDebounceMs(
  config: Pick<TelegramChannelAccount, "inboundDebounceMs">,
): number {
  const raw =
    typeof process === "undefined"
      ? undefined
      : process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const envOverride = Number(raw);
    if (Number.isFinite(envOverride) && envOverride >= 0) {
      return Math.trunc(Math.min(envOverride, TELEGRAM_DEBOUNCE_MAX_MS));
    }
  }

  const fromConfig = config.inboundDebounceMs;
  if (
    typeof fromConfig === "number" &&
    Number.isFinite(fromConfig) &&
    fromConfig >= 0
  ) {
    return Math.trunc(Math.min(fromConfig, TELEGRAM_DEBOUNCE_MAX_MS));
  }

  return TELEGRAM_DEBOUNCE_DEFAULT_MS;
}

export type TelegramDebounceInput = {
  chatId: string;
  threadId?: string | null;
};

export function buildTelegramDebounceKey(
  input: TelegramDebounceInput,
  accountId: string,
): string | null {
  if (!input.chatId.trim()) {
    return null;
  }
  return `telegram:${accountId}:${input.chatId}:${input.threadId ?? "main"}`;
}

export { TELEGRAM_DEBOUNCE_DEFAULT_MS, TELEGRAM_DEBOUNCE_MAX_MS };
