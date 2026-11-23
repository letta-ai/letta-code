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

    const gateIndex = source.indexOf(
      "if (\n      !streaming ||\n      interruptRequested ||\n      abortedControllerWitness ||\n      staleTurnUnwindingRef.current\n    ) {",
    );
    expect(gateIndex).toBeGreaterThanOrEqual(0);

    const settleIndex = source.indexOf("settleTuiInterrupt({", gateIndex);
    expect(settleIndex).toBeGreaterThan(gateIndex);

    const retryIndex = source.indexOf(
      "interruptStopFailedSubagents(",
      settleIndex,
    );
    expect(retryIndex).toBeGreaterThan(settleIndex);

    const feedbackIndex = source.indexOf(
      "Retrying stop of background task",
      retryIndex,
    );
    expect(feedbackIndex).toBeGreaterThan(retryIndex);
  });

  test("idle Esc reaches the interrupt handler only through the full prop chain", () => {
    const input = readAppSource("../components/InputRich.tsx");
    expect(input).toContain(
      "streaming || interruptRequested || hasStopFailedTasks",
    );

    const view = readAppSource("./AppView.tsx");
    expect(view).toContain("hasStopFailedTasks={hasStopFailedTasks}");

    const coordinator = readAppSource("./AppCoordinator.tsx");
    expect(coordinator).toContain("hasStopFailedSubagents({");
    expect(coordinator).toContain("hasStopFailedTasks={hasStopFailedTasks}");
    expect(coordinator).toContain("selectStopFailedNotifications(");
    expect(coordinator).toContain("stopFailedNotifiedRef.current,");
    expect(coordinator).not.toContain("stopFailedRetryingRef");
    expect(coordinator).toContain("{ agentId, conversationId },");
    expect(coordinator).toContain("[...failures, ...stops]");
  });
});
