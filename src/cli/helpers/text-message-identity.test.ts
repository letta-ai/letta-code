import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers, onChunk, toLines } from "./accumulator";
import { resolveTextLineId } from "./text-message-identity";

describe("text message identity", () => {
  for (const kind of ["assistant", "reasoning"] as const) {
    test(`${kind} resolves mixed id/otid chunks to one block`, () => {
      const buffers = createBuffers();
      expect(resolveTextLineId(buffers, { otid: "client" }, kind)).toBe(
        "client",
      );
      expect(
        resolveTextLineId(buffers, { id: "message", otid: "client" }, kind),
      ).toBe("client");
      expect(resolveTextLineId(buffers, { id: "message" }, kind)).toBe(
        "client",
      );
      expect(resolveTextLineId(buffers, {}, kind)).toBeUndefined();
    });

    test(`${kind} keeps new OTIDs separate across an intervening text kind`, () => {
      const buffers = createBuffers();
      function block(text: string, otid?: string): LettaStreamingResponse {
        return {
          message_type: `${kind}_message`,
          id: "shared-message",
          otid,
          ...(kind === "assistant"
            ? { content: [{ type: "text", text }] }
            : { reasoning: text }),
        } as LettaStreamingResponse;
      }

      onChunk(buffers, block("First block.", "block-1"));
      onChunk(buffers, {
        message_type:
          kind === "assistant" ? "reasoning_message" : "assistant_message",
        id: "other-kind",
        date: "2026-01-01T00:00:00Z",
        reasoning: "Interleaved reasoning.",
        content: [{ type: "text", text: "Interleaved answer." }],
      } as LettaStreamingResponse);
      onChunk(buffers, block("Second block.", "block-2"));
      onChunk(buffers, block(" More detail."));

      const blocks = toLines(buffers).filter((line) => line.kind === kind);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toMatchObject({
        id: "shared-message",
        text: "First block.",
      });
      expect(blocks[1]).toMatchObject({
        id: "block-2",
        text: "Second block. More detail.",
      });
    });
  }
});
