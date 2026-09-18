import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { XChatPollState } from "./poll-state";

let channelsRoot: string;

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-xchat-state-"));
  __testOverrideChannelsRoot(channelsRoot);
});

afterEach(() => {
  __testOverrideChannelsRoot(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

test("keeps independent watermarks for each conversation", () => {
  const state = new XChatPollState("account");
  state.add("conversation-a", "a-1", 100);
  for (let index = 0; index < 5_001; index += 1) {
    state.add("conversation-b", `b-${index}`, 200 + index);
  }

  expect(state.has("conversation-a", "a-1", 100)).toBe(true);
  expect(state.has("conversation-a", "a-new", 101)).toBe(false);
  expect(state.has("conversation-b", "b-0", 200)).toBe(true);
});

test("persists same-timestamp IDs without replaying one conversation", () => {
  const state = new XChatPollState("account");
  state.add("conversation-a", "a-1", 100);
  state.add("conversation-a", "a-2", 100);
  state.save();

  const restored = new XChatPollState("account");
  expect(restored.has("conversation-a", "a-1", 100)).toBe(true);
  expect(restored.has("conversation-a", "a-2", 100)).toBe(true);
  expect(restored.has("conversation-a", "a-3", 100)).toBe(false);
  expect(restored.has("conversation-a", "older", 99)).toBe(true);
});

test("uses event sequence when a newer event has an older timestamp", () => {
  const state = new XChatPollState("account");
  state.add("conversation-a", "a-10", 100, "10");

  expect(state.has("conversation-a", "a-11", 50, "11")).toBe(false);
  state.add("conversation-a", "a-11", 50, "11");
  expect(state.has("conversation-a", "a-10", 100, "10")).toBe(true);
});
