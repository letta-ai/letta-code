export type WhatsAppReconnectScheduler = {
  now(): number;
  schedule(
    delayMs: number,
    callback: () => void,
    options?: { unref?: boolean },
  ): { cancel(): void };
};

export type WhatsAppReconnectTimer = {
  generation: number;
  task: { cancel(): void } | null;
};

export function createDefaultWhatsAppReconnectScheduler(): WhatsAppReconnectScheduler {
  return {
    now: () => Date.now(),
    schedule(delayMs, callback, options) {
      const timer = setTimeout(callback, delayMs) as ReturnType<
        typeof setTimeout
      > & { unref?: () => void };
      if (options?.unref) timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
  };
}
