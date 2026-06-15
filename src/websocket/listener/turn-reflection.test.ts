import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuffers, toLines } from "@/cli/helpers/accumulator";
import { __listenerTurnTestUtils } from "@/websocket/listener/turn";

describe("post-turn listener reflection", () => {
  test("seeds inbound websocket user rows into the reflection transcript buffer", () => {
    const lines = __listenerTurnTestUtils.buildInboundUserTranscriptLines([
      {
        role: "user",
        content: "remember this",
        otid: "client-message-1",
      },
    ]);
    const buffers = createBuffers("agent-1");

    __listenerTurnTestUtils.seedInboundUserTranscriptLines(buffers, lines);

    expect(toLines(buffers)).toEqual([
      {
        kind: "user",
        id: "user-client-message-1",
        text: "remember this",
        otid: "client-message-1",
      },
    ]);
    expect(buffers.userLineIdByOtid.get("client-message-1")).toBe(
      "user-client-message-1",
    );
  });

  test("records listener transcript rows before evaluating post-turn reflection", () => {
    const turnPath = fileURLToPath(new URL("./turn.ts", import.meta.url));
    const source = readFileSync(turnPath, "utf-8");
    const appendIndex = source.indexOf(
      "appendTranscriptDeltaJsonlForStopReason(",
    );
    const launchIndex = source.indexOf("maybeLaunchPostTurnReflection({");

    expect(appendIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(appendIndex);
  });

  test("evaluates post-turn reflection for all turns, not just channel turns", () => {
    const turnPath = fileURLToPath(new URL("./turn.ts", import.meta.url));
    const source = readFileSync(turnPath, "utf-8");

    // The channel-only gate was removed: every end_turn evaluates reflection.
    expect(source).not.toContain("hasChannelTurnSources");
    expect(source).toContain("maybeLaunchPostTurnReflection({");
  });
});
