import { expect, mock, test } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import type {
  TypingControllerTimers,
  TypingTimerHandle,
} from "@/channels/typing-controller-timers";
import { createDiscordTypingController } from "./typing-controller";

type RecordedTimer = {
  callback: () => void;
  handle: TypingTimerHandle;
};

function createRecordedTimers() {
  let nextId = 0;
  const intervals: RecordedTimer[] = [];
  const timeouts: RecordedTimer[] = [];
  const clearedIntervals = new Set<TypingTimerHandle>();
  const clearedTimeouts = new Set<TypingTimerHandle>();
  function handle(): TypingTimerHandle {
    return {
      id: ++nextId,
      unref: () => undefined,
    } as unknown as TypingTimerHandle;
  }
  const timers: TypingControllerTimers = {
    setInterval: (callback) => {
      const timer = { callback, handle: handle() };
      intervals.push(timer);
      return timer.handle;
    },
    clearInterval: (timer) => {
      clearedIntervals.add(timer);
    },
    setTimeout: (callback) => {
      const timer = { callback, handle: handle() };
      timeouts.push(timer);
      return timer.handle;
    },
    clearTimeout: (timer) => {
      clearedTimeouts.add(timer);
    },
  };
  return {
    timers,
    intervals,
    timeouts,
    clearedIntervals,
    clearedTimeouts,
  };
}

function source(messageId: string): ChannelTurnSource {
  return {
    channel: "discord",
    accountId: "discord-1",
    chatId: "channel-1",
    messageId,
    agentId: "agent-1",
    conversationId: "conv-1",
  };
}

test("successful refresh pulses do not extend the lost-terminal watchdog", async () => {
  const recorded = createRecordedTimers();
  const sendTypingAction = mock(async () => true);
  const controller = createDiscordTypingController({
    sendTypingAction,
    timers: recorded.timers,
  });

  await controller.start(source("message-1"));
  const watchdogCountAfterStart = recorded.timeouts.length;
  expect(watchdogCountAfterStart).toBe(2);

  recorded.intervals[0]?.callback();
  await Promise.resolve();
  expect(recorded.timeouts).toHaveLength(watchdogCountAfterStart);

  const activeWatchdog = recorded.timeouts.at(-1);
  const refreshInterval = recorded.intervals[0];
  expect(refreshInterval).toBeDefined();
  activeWatchdog?.callback();
  if (refreshInterval) {
    expect(recorded.clearedIntervals).toContain(refreshInterval.handle);
  }
});

test("stale interval failure cannot clear a replacement channel owner", async () => {
  const recorded = createRecordedTimers();
  let resolveStaleRefresh!: (ok: boolean) => void;
  const staleRefresh = new Promise<boolean>((resolve) => {
    resolveStaleRefresh = resolve;
  });
  let call = 0;
  const sendTypingAction = mock(async () => {
    call += 1;
    if (call === 2) return staleRefresh;
    return true;
  });
  const controller = createDiscordTypingController({
    sendTypingAction,
    timers: recorded.timers,
  });

  const first = source("message-1");
  await controller.start(first);
  recorded.intervals[0]?.callback();
  expect(call).toBe(2);

  controller.stop(first);
  await controller.start(source("message-2"));
  const replacementInterval = recorded.intervals[1];
  expect(replacementInterval).toBeDefined();

  resolveStaleRefresh(false);
  await Promise.resolve();
  expect(recorded.clearedIntervals).not.toContain(replacementInterval?.handle);
});
