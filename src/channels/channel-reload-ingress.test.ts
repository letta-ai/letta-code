import { expect, test } from "bun:test";
import { ChannelReloadIngress } from "./channel-reload-ingress";
import type { InboundChannelMessage } from "./types";

function inbound(text: string): InboundChannelMessage {
  return {
    channel: "demo",
    accountId: "acct-demo",
    chatId: "chat-demo",
    chatType: "direct",
    senderId: "user-demo",
    text,
    timestamp: Date.now(),
  };
}

test("reload ingress drains arrivals during flush in FIFO order", async () => {
  const events: string[] = [];
  let markFirstStarted: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const ingress = new ChannelReloadIngress(async (message) => {
    events.push(`start:${message.text}`);
    if (message.text === "one") {
      markFirstStarted();
      await firstGate;
    }
    events.push(`finish:${message.text}`);
  });
  const buffering = ingress.begin();

  expect(ingress.defer(inbound("one"))).toBe(true);
  const finish = buffering.finish();
  await firstStarted;
  expect(ingress.isActive()).toBe(true);
  expect(ingress.defer(inbound("two"))).toBe(true);
  releaseFirst();
  await finish;

  expect(events).toEqual([
    "start:one",
    "finish:one",
    "start:two",
    "finish:two",
  ]);
  expect(ingress.isActive()).toBe(false);
  expect(ingress.defer(inbound("three"))).toBe(false);
});
