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

  test("conversation loop evaluates reflection after the transcript append on end_turn", () => {
    const conversationLoopPath = fileURLToPath(
      new URL("./use-conversation-loop.ts", import.meta.url),
    );
    const loopSource = readFileSync(conversationLoopPath, "utf-8");

    const endTurnIndex = loopSource.indexOf(
      'if (stopReasonToHandle === "end_turn")',
    );
    const appendIndex = loopSource.indexOf(
      "appendTranscriptDeltaJsonl(",
      endTurnIndex,
    );
    const reflectionIndex = loopSource.indexOf(
      "await maybeRunPostTurnReflection();",
      endTurnIndex,
    );

    expect(endTurnIndex).toBeGreaterThanOrEqual(0);
    expect(appendIndex).toBeGreaterThan(endTurnIndex);
    expect(reflectionIndex).toBeGreaterThan(appendIndex);
  });

  test("manual /compact launches compaction reflection directly", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./use-submit-handler.ts", import.meta.url),
    );
    const source = readFileSync(submitHandlerPath, "utf-8");

    expect(source).toContain('triggerSource: "compaction-event"');
    expect(source).toContain("skipPendingWorktreeReminderScan: true");
    expect(source).not.toContain("queuePendingReflectionWorktreeReminders");
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
    expect(loopSource).toContain("appendTranscriptDeltaJsonl(");

    expect(
      loopSource.indexOf('if (stopReasonToHandle === "end_turn")'),
    ).toBeLessThan(loopSource.indexOf("appendTranscriptDeltaJsonl("));
  });
});
