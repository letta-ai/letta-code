import { describe, expect, test } from "bun:test";
import {
  estimateLocalContextTokens,
  estimateLocalMessagesTokens,
} from "./local-context-estimate";
import { emptyLocalUsage, type LocalMessage } from "./local-message";

function usage(totalTokens: number) {
  return { ...emptyLocalUsage(), totalTokens };
}

describe("local context estimate", () => {
  test("counts semantic content instead of serialized image payloads", () => {
    const hugeBase64 = "a".repeat(1_000_000);
    const messages: LocalMessage[] = [
      {
        id: "ui-msg-image",
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: hugeBase64 },
        ],
        timestamp: Date.now(),
      },
    ];

    expect(estimateLocalMessagesTokens(messages)).toBe(1201);
  });

  test("uses last successful assistant usage plus trailing message estimates", () => {
    const messages: LocalMessage[] = [
      {
        id: "ui-msg-old-image",
        role: "user",
        content: [
          { type: "image", mimeType: "image/png", data: "a".repeat(1_000_000) },
        ],
        timestamp: Date.now(),
      },
      {
        id: "ui-msg-assistant",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: usage(407_000),
        stopReason: "stop",
        timestamp: Date.now(),
      },
      {
        id: "ui-msg-trailing",
        role: "user",
        content: "keep going",
        timestamp: Date.now(),
      },
    ];

    expect(estimateLocalContextTokens(messages)).toMatchObject({
      tokens: 407_003,
      usageTokens: 407_000,
      trailingTokens: 3,
      lastUsageIndex: 1,
    });
  });

  test("ignores stale pre-compaction usage anchors kept after a summary message", () => {
    const compactionTime = 1_000_000;
    const messages: LocalMessage[] = [
      {
        id: "ui-msg-summary",
        role: "user",
        metadata: {
          compaction: { summary: "old work summarized" },
        },
        content: [{ type: "text", text: "x".repeat(400) }],
        timestamp: compactionTime,
      },
      {
        id: "ui-msg-kept-assistant",
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(400) }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        // Stale: responded before compaction, usage reflects the old context.
        usage: usage(407_000),
        stopReason: "stop",
        timestamp: compactionTime - 5_000,
      },
    ];

    // No trustworthy usage anchor -> falls back to semantic estimate.
    expect(estimateLocalContextTokens(messages)).toMatchObject({
      tokens: 200,
      usageTokens: 0,
      trailingTokens: 200,
      lastUsageIndex: null,
    });
  });

  test("anchors on assistant usage from after the latest compaction", () => {
    const compactionTime = 1_000_000;
    const messages: LocalMessage[] = [
      {
        id: "ui-msg-summary",
        role: "user",
        metadata: {
          compaction: { summary: "old work summarized" },
        },
        content: [{ type: "text", text: "summary" }],
        timestamp: compactionTime,
      },
      {
        id: "ui-msg-kept-assistant",
        role: "assistant",
        content: [{ type: "text", text: "stale" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: usage(407_000),
        stopReason: "stop",
        timestamp: compactionTime - 5_000,
      },
      {
        id: "ui-msg-fresh-assistant",
        role: "assistant",
        content: [{ type: "text", text: "fresh" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: usage(90_000),
        stopReason: "stop",
        timestamp: compactionTime + 5_000,
      },
      {
        id: "ui-msg-trailing",
        role: "user",
        content: "next",
        timestamp: compactionTime + 6_000,
      },
    ];

    expect(estimateLocalContextTokens(messages)).toMatchObject({
      tokens: 90_001,
      usageTokens: 90_000,
      lastUsageIndex: 2,
    });
  });
});
