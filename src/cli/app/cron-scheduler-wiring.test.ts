import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("TUI cron scheduler wiring", () => {
  test("uses the shared task preflight before normal firing", () => {
    const coordinatorPath = fileURLToPath(
      new URL("./AppCoordinator.tsx", import.meta.url),
    );
    const source = readFileSync(coordinatorPath, "utf-8");

    const importIndex = source.indexOf("handleTaskPreflight,");
    const schedulerLoopIndex = source.indexOf(
      "for (const task of activeTasks)",
    );
    const preflightIndex = source.indexOf(
      "handleTaskPreflight(task, now)",
      schedulerLoopIndex,
    );
    const shouldFireIndex = source.indexOf(
      "shouldFireTask(task, now)",
      schedulerLoopIndex,
    );

    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(schedulerLoopIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeGreaterThan(schedulerLoopIndex);
    expect(preflightIndex).toBeLessThan(shouldFireIndex);
  });
});
