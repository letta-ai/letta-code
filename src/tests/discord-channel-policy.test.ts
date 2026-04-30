import { describe, expect, test } from "bun:test";

import { shouldProcessGuildMessage } from "../channels/discord/channelPolicy";

describe("shouldProcessGuildMessage", () => {
  // ── Default (undefined) = "mention" ──────────────────────────────

  test("returns false for non-mentioned, non-thread message with default policy", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: false,
        wasMentioned: false,
      }),
    ).toBe(false);
  });

  test("returns true for thread message with default policy", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: true,
        wasMentioned: false,
      }),
    ).toBe(true);
  });

  test("returns true for mentioned message with default policy", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: false,
        wasMentioned: true,
      }),
    ).toBe(true);
  });

  test("returns true for mentioned thread message with default policy", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: true,
        wasMentioned: true,
      }),
    ).toBe(true);
  });

  // ── Explicit "mention" policy ────────────────────────────────────

  test("returns false for non-mentioned, non-thread with explicit 'mention'", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: false,
        wasMentioned: false,
        channelPolicy: "mention",
      }),
    ).toBe(false);
  });

  test("returns true for thread with explicit 'mention'", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: true,
        wasMentioned: false,
        channelPolicy: "mention",
      }),
    ).toBe(true);
  });

  // ── "open" policy ───────────────────────────────────────────────

  test("returns true for non-mentioned, non-thread with 'open' policy", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: false,
        wasMentioned: false,
        channelPolicy: "open",
      }),
    ).toBe(true);
  });

  test("returns true for thread with 'open' policy", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: true,
        wasMentioned: false,
        channelPolicy: "open",
      }),
    ).toBe(true);
  });

  test("returns true for mentioned message with 'open' policy", () => {
    expect(
      shouldProcessGuildMessage({
        isThread: false,
        wasMentioned: true,
        channelPolicy: "open",
      }),
    ).toBe(true);
  });
});
