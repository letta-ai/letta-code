export type TypingTimerHandle = ReturnType<typeof setTimeout>;

export interface TypingControllerTimers {
  setInterval(callback: () => void, delayMs: number): TypingTimerHandle;
  clearInterval(handle: TypingTimerHandle): void;
  setTimeout(callback: () => void, delayMs: number): TypingTimerHandle;
  clearTimeout(handle: TypingTimerHandle): void;
}

export const SYSTEM_TYPING_CONTROLLER_TIMERS: TypingControllerTimers = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};
