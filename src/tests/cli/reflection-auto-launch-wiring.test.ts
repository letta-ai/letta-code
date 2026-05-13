import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readInteractiveAppSource } from "../helpers/readInteractiveAppSource";

describe("reflection auto-launch wiring", () => {
  test("routes step-count and compaction-event auto-launch through shared reminder engine", () => {
    const enginePath = fileURLToPath(
      new URL("../../reminders/engine.ts", import.meta.url),
    );
    const appSource = readInteractiveAppSource();
    const engineSource = readFileSync(enginePath, "utf-8");

    expect(appSource).toContain("const maybeLaunchReflectionSubagent = async");
    expect(appSource).toContain("hasActiveReflectionSubagent(agentId,");
    expect(appSource).toContain("buildAutoReflectionPayload(");
    expect(appSource).toContain("finalizeAutoReflectionPayload(");
    expect(appSource).toContain("spawnBackgroundSubagentTask({");
    const reflectionPromptBlocks = [
      ...appSource.matchAll(
        /buildReflectionSubagentPrompt\(\{[\s\S]*?\n\s*\}\);/g,
      ),
    ].map((match) => match[0]);
    expect(reflectionPromptBlocks.length).toBeGreaterThanOrEqual(2);
    expect(reflectionPromptBlocks.some((block) => block.includes("cwd:"))).toBe(
      false,
    );
    // Prompt blocks should no longer include a transcriptPath field — the
    // transcript path is now passed via TRANSCRIPT_PATH env var on the
    // spawned subagent's child process, not interpolated into the prompt.
    expect(
      reflectionPromptBlocks.some((block) => block.includes("transcriptPath:")),
    ).toBe(false);
    // ...but the spawn call should still receive the transcript path so it
    // can be forwarded as $TRANSCRIPT_PATH to the subagent.
    expect(appSource).toContain("transcriptPath: autoPayload.payloadPath");
    expect(appSource).toContain("maybeLaunchReflectionSubagent,");

    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("step-count")',
    );
    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("compaction-event")',
    );
  });

  test("/remember sends REMEMBER_PROMPT to primary agent via processConversation", () => {
    const appSource = readInteractiveAppSource();

    // /remember uses the primary agent path (no subagent)
    expect(appSource).toContain("REMEMBER_PROMPT");
    expect(appSource).toContain("processConversation([");
    expect(appSource).toContain("The user did not specify what to remember.");
  });
});
