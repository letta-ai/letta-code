import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import taskSchema from "@/tools/schemas/Task.json";

describe("Agent background-only execution", () => {
  test("does not expose a foreground launch argument", () => {
    expect(taskSchema.properties).not.toHaveProperty("run_in_background");
    expect(taskSchema.properties).toHaveProperty("computer");
    expect(taskSchema.required).not.toContain("computer");
    expect(taskSchema.properties.computer.description).toContain(
      "Use only when the task must run somewhere other than the current computer",
    );
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

  test("prompts computer routing as optional and exceptional", () => {
    const descriptionPath = fileURLToPath(
      new URL("../tools/descriptions/Task.md", import.meta.url),
    );
    const description = readFileSync(descriptionPath, "utf-8");

    expect(description).toContain("The `computer` parameter is optional");
    expect(description).toContain(
      "Set `computer` only when the task specifically needs",
    );
    expect(description).toContain(
      "Do not set `computer` merely to run work in parallel or in the background",
    );
  });
});
