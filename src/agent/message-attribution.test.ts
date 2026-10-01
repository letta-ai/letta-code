import { expect, test } from "bun:test";
import {
  type AttributedMessageCreate,
  withMessageAttribution,
} from "./message-attribution";

test("legacy user attribution is added without changing content or correlation", () => {
  const message = { role: "user" as const, content: "hello", otid: "otid-1" };
  expect(withMessageAttribution(message, "human")).toEqual({
    ...message,
    attribution: { acting_user_id: "human" },
  });
  expect(withMessageAttribution(message)).toBe(message);
});

test("explicit bearer and human attribution survive unchanged", () => {
  for (const attribution of [{}, { acting_user_id: "other" }]) {
    const message: AttributedMessageCreate = {
      role: "user",
      content: "hello",
      attribution,
    };
    expect(withMessageAttribution(message, "human")).toBe(message);
  }
});

test("non-user messages are not attributed as human input", () => {
  const message = { role: "assistant" as const, content: "hello" };
  expect(withMessageAttribution(message, "human")).toBe(message);
});
