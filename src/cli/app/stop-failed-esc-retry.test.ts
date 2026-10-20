import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readAppSource(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf-8",
  );
}

describe("stop-failed background task retry wiring", () => {
  test("idle Esc retries a stop-failed task through the interrupt handler", () => {
    const source = readAppSource("./use-interrupt-handler.ts");

    // The idle/escalation gate.
    const gateIndex = source.indexOf(
      "if (!streaming || interruptRequested || abortedControllerWitness) {",
    );
    expect(gateIndex).toBeGreaterThanOrEqual(0);

    // The escalation block settles first; the stop-failed retry must come
    // after it so an unwinding interrupt does not double-fire, and before
    // the gate's return.
    const settleIndex = source.indexOf("settleTuiInterrupt({", gateIndex);
    expect(settleIndex).toBeGreaterThan(gateIndex);

    const guardIndex = source.indexOf("hasStopFailedSubagents(", settleIndex);
    expect(guardIndex).toBeGreaterThan(settleIndex);

    const retryIndex = source.indexOf(
      "interruptSubagentsAndReleaseReflection(",
      guardIndex,
    );
    expect(retryIndex).toBeGreaterThan(guardIndex);

    const feedbackIndex = source.indexOf(
      "Retrying stop of background task",
      guardIndex,
    );
    expect(feedbackIndex).toBeGreaterThan(guardIndex);
  });

  test("idle Esc reaches the interrupt handler only through the full prop chain", () => {
    // InputRich forwards idle Esc when a stop failed.
    const input = readAppSource("../components/InputRich.tsx");
    expect(input).toContain(
      "streaming || interruptRequested || hasStopFailedTasks",
    );

    // AppView threads the flag into the composer.
    const view = readAppSource("./AppView.tsx");
    expect(view).toContain("hasStopFailedTasks={hasStopFailedTasks}");

    // AppCoordinator derives the flag from the subagent store and surfaces
    // the failure as a transcript event instead of a silent restore.
    const coordinator = readAppSource("./AppCoordinator.tsx");
    expect(coordinator).toContain("hasStopFailedSubagents({");
    expect(coordinator).toContain("hasStopFailedTasks={hasStopFailedTasks}");
    expect(coordinator).toContain("selectStopFailedNotifications(");
  });
});
