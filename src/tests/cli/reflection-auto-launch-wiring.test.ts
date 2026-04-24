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
    const helperPath = fileURLToPath(
      new URL("../../cli/helpers/autoReflection.ts", import.meta.url),
    );
    const appSource = readFileSync(appPath, "utf-8");
    const engineSource = readFileSync(enginePath, "utf-8");
    const helperSource = readFileSync(helperPath, "utf-8");

    expect(appSource).toContain("const maybeLaunchReflectionSubagent = async");
    expect(appSource).toContain("launchReflectionSubagent({");
    expect(appSource).toContain("maybeLaunchReflectionSubagent,");
    expect(appSource).toContain("maybeStartIdleReflectionSweep:");

    expect(helperSource).toContain("hasActiveReflectionSubagent(");
    expect(helperSource).toContain("buildAutoReflectionPayload(");
    expect(helperSource).toContain("finalizeAutoReflectionPayload(");
    expect(helperSource).toContain("spawnBackgroundSubagentTask({");
    expect(helperSource).toContain("reflectionQueueByAgent");

    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("step-count")',
    );
    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("compaction-event")',
    );
  });

  test("/remember sends REMEMBER_PROMPT to primary agent via processConversation", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const appSource = readFileSync(appPath, "utf-8");

    // /remember uses the primary agent path (no subagent)
    expect(appSource).toContain("REMEMBER_PROMPT");
    expect(appSource).toContain("processConversation([");
    expect(appSource).toContain("The user did not specify what to remember.");
  });
});
