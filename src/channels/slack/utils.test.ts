import { expect, test } from "bun:test";
import {
  isProcessableSlackInboundMessage,
  resolveSlackAppConstructor,
} from "./utils";

class FakeSlackApp {}

test("isProcessableSlackInboundMessage keeps live bot messages structurally processable", () => {
  expect(
    isProcessableSlackInboundMessage({
      channel: "C123",
      bot_id: "BDEPLOY",
      subtype: "bot_message",
      text: "deployment failed",
      ts: "1712800000.000100",
    }),
  ).toBe(true);
});

test("isProcessableSlackInboundMessage still rejects bookkeeping wrappers", () => {
  expect(
    isProcessableSlackInboundMessage({
      channel: "C123",
      ts: "1712800000.000101",
      hidden: true,
      subtype: "message_replied",
      message: {
        user: "U123",
        text: "original",
        ts: "1712790000.000050",
      },
    }),
  ).toBe(false);
});

test("resolveSlackAppConstructor supports nested default Slack Bolt exports", () => {
  const nestedModule = {
    default: {
      default: {
        App: FakeSlackApp,
      },
    },
  } as unknown as Parameters<typeof resolveSlackAppConstructor>[0];

  expect(resolveSlackAppConstructor(nestedModule) as unknown).toBe(
    FakeSlackApp,
  );
});
