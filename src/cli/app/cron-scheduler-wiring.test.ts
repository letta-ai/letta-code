import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("TUI cron scheduler wiring", () => {
  test("uses the shared invalid recurring cron handler before normal firing", () => {
    const coordinatorPath = fileURLToPath(
      new URL("./AppCoordinator.tsx", import.meta.url),
    );
    const source = readFileSync(coordinatorPath, "utf-8");

    const importIndex = source.indexOf("handleInvalidRecurringTask,");
    const schedulerLoopIndex = source.indexOf(
      "for (const task of activeTasks)",
    );
    const invalidHandlerIndex = source.indexOf(
      "handleInvalidRecurringTask(task, now)",
      schedulerLoopIndex,
    );
    const missedOneShotIndex = source.indexOf(
      "handleMissedOneShot(task, now)",
      schedulerLoopIndex,
    );
    const shouldFireIndex = source.indexOf(
      "shouldFireTask(task, now)",
      schedulerLoopIndex,
    );

    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(schedulerLoopIndex).toBeGreaterThanOrEqual(0);
    expect(invalidHandlerIndex).toBeGreaterThan(schedulerLoopIndex);
    expect(invalidHandlerIndex).toBeLessThan(missedOneShotIndex);
    expect(invalidHandlerIndex).toBeLessThan(shouldFireIndex);
  });
});
