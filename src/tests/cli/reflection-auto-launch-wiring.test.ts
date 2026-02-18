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
    expect(appSource).toContain("spawnBackgroundSubagentTask({");
    expect(appSource).toContain("maybeLaunchReflectionSubagent,");

    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("step-count")',
    );
    expect(engineSource).toContain(
      'await context.maybeLaunchReflectionSubagent("compaction-event")',
    );
  });
});
