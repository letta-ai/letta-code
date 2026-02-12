import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("reflection auto-launch wiring", () => {
  test("handles step-count and compaction-event auto-launch modes", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain("const maybeLaunchReflectionSubagent = async");
    expect(source).toContain(
      'await maybeLaunchReflectionSubagent("step-count")',
    );
    expect(source).toContain(
      'await maybeLaunchReflectionSubagent("compaction-event")',
    );
    expect(source).toContain("hasActiveReflectionSubagent()");
    expect(source).toContain("spawnBackgroundSubagentTask({");
  });
});
