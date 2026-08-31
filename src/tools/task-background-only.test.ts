import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import taskSchema from "@/tools/schemas/Task.json";

describe("Agent background-only execution", () => {
  test("does not expose a foreground launch argument", () => {
    expect(taskSchema.properties).not.toHaveProperty("run_in_background");
    expect(taskSchema.additionalProperties).toBe(false);
  });

  test("routes every Agent launch through the background task helper", () => {
    const taskPath = fileURLToPath(
      new URL("../tools/impl/task.ts", import.meta.url),
    );
    const source = readFileSync(taskPath, "utf-8");

    expect(source).not.toContain("run_in_background");
    expect(source).not.toContain("foregroundTaskId");
    expect(source).toContain(
      "const { taskId, outputFile, subagentId } = spawnBackgroundSubagentTask({",
    );
  });
});
