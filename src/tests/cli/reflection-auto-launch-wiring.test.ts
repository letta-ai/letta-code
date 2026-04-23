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
    expect(appSource).toContain("hasActiveReflectionSubagent(agentId,");
    expect(appSource).toContain("buildAutoReflectionPayload(");
    expect(appSource).toContain("finalizeAutoReflectionPayload(");
    expect(appSource).toContain("spawnBackgroundSubagentTask({");
    expect(appSource).toContain("maybeLaunchReflectionSubagent,");

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
