import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import {
  type BidirectionalQueuedInput,
  mergeBidirectionalQueuedInput,
} from "../../headless";

describe("headless bidirectional queue merging", () => {
  test("merges queued user and task notification inputs into one content payload", () => {
    const queued: BidirectionalQueuedInput[] = [
      { kind: "user", content: "first user message" },
      {
        kind: "task_notification",
        text: "<task-notification><summary>done</summary></task-notification>",
      },
      { kind: "user", content: "second user message" },
    ];

    const merged = mergeBidirectionalQueuedInput(queued);
    expect(Array.isArray(merged)).toBe(true);
    if (!Array.isArray(merged)) return;

    const textParts = merged.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    expect(textParts.join("")).toContain("first user message");
    expect(textParts.join("")).toContain("<task-notification>");
    expect(textParts.join("")).toContain("second user message");
  });

  test("preserves multimodal user content parts", () => {
    const multimodal = [
      { type: "text", text: "describe image" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ] as unknown as Exclude<MessageCreate["content"], string>;

    const queued: BidirectionalQueuedInput[] = [
      { kind: "user", content: multimodal },
    ];

    const merged = mergeBidirectionalQueuedInput(queued);
    expect(Array.isArray(merged)).toBe(true);
    if (!Array.isArray(merged)) return;
    expect(merged[0]).toEqual(multimodal[0]);
    expect(merged[1]).toEqual(multimodal[1]);
  });
});

describe("headless bidirectional queue wiring", () => {
  test("registers and clears messageQueueBridge adder in bidirectional mode", () => {
    const headlessPath = fileURLToPath(
      new URL("../../headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("setMessageQueueAdder((queuedMessage) =>");
    expect(source).toContain("serializeQueuedMessageAsUserLine");
    expect(source).toContain("_queuedKind");
    expect(source).toContain("setMessageQueueAdder(null)");
  });
});
