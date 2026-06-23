import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("interactive reflection transcript wiring", () => {
  test("coordinator wires the reflection launcher into the post-turn check", () => {
    const coordinatorPath = fileURLToPath(
      new URL("./AppCoordinator.tsx", import.meta.url),
    );
    const source = readFileSync(coordinatorPath, "utf-8");

    expect(source).toContain("const maybeRunPostTurnReflection = useCallback(");
    expect(source).toContain("maybeLaunchPostTurnReflection({");
    expect(source).toContain("launchReflectionSubagent({");
    expect(source).toContain("description: AUTO_REFLECTION_DESCRIPTION");
  });

  test("conversation loop evaluates reflection after the transcript append", () => {
    const conversationLoopPath = fileURLToPath(
      new URL("./use-conversation-loop.ts", import.meta.url),
    );
    const loopSource = readFileSync(conversationLoopPath, "utf-8");

    const appendIndex = loopSource.indexOf(
      "appendTranscriptDeltaJsonlForStopReason(",
    );
    const reflectionIndex = loopSource.indexOf(
      "await maybeRunPostTurnReflection();",
    );

    expect(appendIndex).toBeGreaterThanOrEqual(0);
    expect(reflectionIndex).toBeGreaterThan(appendIndex);
  });

  test("manual /compact launches compaction reflection directly", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./use-submit-handler.ts", import.meta.url),
    );
    const source = readFileSync(submitHandlerPath, "utf-8");

    expect(source).toContain('triggerSource: "compaction-event"');
    expect(source).not.toContain("pendingReflectionTrigger = true");
  });

  test("successful TUI turns append user and assistant rows to the reflection transcript", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./use-submit-handler.ts", import.meta.url),
    );
    const conversationLoopPath = fileURLToPath(
      new URL("./use-conversation-loop.ts", import.meta.url),
    );
    const submitSource = readFileSync(submitHandlerPath, "utf-8");
    const loopSource = readFileSync(conversationLoopPath, "utf-8");

    expect(submitSource).toContain(
      "const transcriptStartLineIndex = userTextForInput",
    );
    expect(submitSource).toContain("transcriptStartLineIndex,");
    expect(loopSource).toContain("const transcriptTurnStartLineIndex =");
    expect(loopSource).toContain('if (stopReasonToHandle === "end_turn")');
    expect(loopSource).toContain("toLines(buffersRef.current).slice(");
    expect(loopSource).toContain("appendTranscriptDeltaJsonlForStopReason(");
    expect(loopSource).toContain("stopReasonToHandle,");

    expect(
      loopSource.indexOf("appendTranscriptDeltaJsonlForStopReason("),
    ).toBeLessThan(
      loopSource.indexOf('if (stopReasonToHandle === "end_turn")'),
    );
  });
});
