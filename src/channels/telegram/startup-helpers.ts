import type { ChannelAdapterStartOptions } from "@/channels/types";
import type { TelegramBot } from "./internal-types";

export const DEFAULT_TELEGRAM_INIT_TIMEOUT_MS = 15_000;

export const DEFAULT_TELEGRAM_START_TIMEOUT_MS = 20_000;

export const TELEGRAM_FAILED_START_STOP_TIMEOUT_MS = 5_000;

export function getStartupTimeoutMs(
  envName: string,
  fallbackMs: number,
): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallbackMs;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export function withStartupTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(value);
      },
      (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      },
    );
  });
}

export function logTelegramStartup(
  options: ChannelAdapterStartOptions | undefined,
  message: string,
): void {
  options?.logger?.(`[Telegram] ${message}`);
}

export async function stopTelegramBotQuietly(
  telegramBot: TelegramBot,
  options: ChannelAdapterStartOptions | undefined,
): Promise<void> {
  try {
    await withStartupTimeout(
      telegramBot.stop(),
      "Telegram bot stop after failed startup",
      TELEGRAM_FAILED_START_STOP_TIMEOUT_MS,
    );
  } catch (error) {
    logTelegramStartup(
      options,
      `stop after failed startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
