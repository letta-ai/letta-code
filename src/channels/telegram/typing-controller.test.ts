import { expect, mock, test } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import type {
  TypingControllerTimers,
  TypingTimerHandle,
} from "@/channels/typing-controller-timers";
import { createTelegramTypingController } from "./typing-controller";

type RecordedTimer = {
  callback: () => void;
  handle: TypingTimerHandle;
};

function createRecordedTimers() {
  let nextId = 0;
  const intervals: RecordedTimer[] = [];
  const timeouts: RecordedTimer[] = [];
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
    clearInterval: () => undefined,
    setTimeout: (callback) => {
      const timer = { callback, handle: handle() };
      timeouts.push(timer);
      return timer.handle;
    },
    clearTimeout: () => undefined,
  };
  return { timers, intervals, timeouts };
}

function source(): ChannelTurnSource {
  return {
    channel: "telegram",
    accountId: "telegram-1",
    chatId: "chat-1",
    threadId: "topic-1",
    messageId: "message-1",
    agentId: "agent-1",
    conversationId: "conv-1",
  };
}

test("refresh pulses do not extend the watchdog", () => {
  const recorded = createRecordedTimers();
  const sendTypingAction = mock(async () => undefined);
  const controller = createTelegramTypingController({
    sendTypingAction,
    timers: recorded.timers,
  });

  controller.start(source());
  expect(recorded.timeouts).toHaveLength(1);
  recorded.intervals[0]?.callback();
  expect(recorded.timeouts).toHaveLength(1);
});

test("outbound activity suppresses the next typing refresh and slides watchdog", () => {
  const recorded = createRecordedTimers();
  const sendTypingAction = mock(async () => undefined);
  const controller = createTelegramTypingController({
    sendTypingAction,
    timers: recorded.timers,
  });

  controller.start(source());
  expect(sendTypingAction).toHaveBeenCalledTimes(1);
  controller.markOutbound("chat-1", "topic-1");
  expect(recorded.timeouts).toHaveLength(2);

  recorded.intervals[0]?.callback();
  expect(sendTypingAction).toHaveBeenCalledTimes(1);
});
