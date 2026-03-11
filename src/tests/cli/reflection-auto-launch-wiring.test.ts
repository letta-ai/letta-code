import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("reflection auto-launch wiring", () => {
  test("routes step-count and compaction-event auto-launch through shared reminder engine", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const enginePath = fileURLToPath(
      new URL("../../reminders/engine.ts", import.meta.url),
    );
    const appSource = readFileSync(appPath, "utf-8");
    const engineSource = readFileSync(enginePath, "utf-8");

    expect(appSource).toContain("const maybeLaunchReflectionSubagent = async");
    expect(appSource).toContain("hasActiveReflectionSubagent()");
    expect(appSource).toContain("buildAutoReflectionPayload(");
    expect(appSource).toContain("finalizeAutoReflectionPayload(");
    expect(appSource).toContain("buildRememberPayloadFromLines(");
    expect(appSource).toContain("spawnBackgroundSubagentTask({");
    expect(appSource).toContain("maybeLaunchReflectionSubagent,");

    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("step-count")',
    );
    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("compaction-event")',
    );
  });

  test("/remember wiring forwards user text through shared reflection prompt builder using rendered transcript", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const helperPath = fileURLToPath(
      new URL("../../cli/helpers/reflectionTranscript.ts", import.meta.url),
    );
    const appSource = readFileSync(appPath, "utf-8");
    const helperSource = readFileSync(helperPath, "utf-8");

    expect(appSource).toContain("buildReflectionSubagentPrompt({");
    expect(appSource).toContain("rememberUserText: userText || undefined");
    expect(appSource).toContain(
      "const currentLines = toLines(buffersRef.current);",
    );
    expect(appSource).toContain("buildRememberPayloadFromLines(");
    expect(appSource).toContain(
      "No rendered transcript content available to remember yet.",
    );

    expect(helperSource).toContain("The user specifically asked to remember");
  });
});
