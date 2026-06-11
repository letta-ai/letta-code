import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("interactive reflection transcript wiring", () => {
  test("submit handler launches step-count reflection through shared reminders", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./use-submit-handler.ts", import.meta.url),
    );
    const source = readFileSync(submitHandlerPath, "utf-8");

    expect(source).toContain("const maybeLaunchReflectionSubagent = async (");
    expect(source).toContain("launchReflectionSubagent({");
    expect(source).toContain("description: AUTO_REFLECTION_DESCRIPTION");
    expect(source).toContain('mode: "interactive"');
    expect(source).toContain("maybeLaunchReflectionSubagent,");
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
