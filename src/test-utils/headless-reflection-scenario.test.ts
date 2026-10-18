import { describe, expect, test } from "bun:test";
import {
  isAcceptedScenarioExit,
  terminateAfterScenarioSatisfied,
} from "./headless-reflection-scenario";

describe("headless reflection smoke lifecycle", () => {
  test("terminates promptly after the foreground contract while reflection work remains live", async () => {
    const activeOrQueuedReflection = new Promise<boolean>(() => {});
    const signals: Array<"SIGTERM"> = [];

    const completed = await Promise.race([
      terminateAfterScenarioSatisfied({
        waitForScenarioSatisfied: async () => true,
        terminate: (signal) => {
          signals.push(signal);
        },
      }),
      activeOrQueuedReflection,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(completed).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("does not terminate or accept a signal before the scenario is satisfied", async () => {
    let terminated = false;
    const satisfied = await terminateAfterScenarioSatisfied({
      waitForScenarioSatisfied: async () => false,
      terminate: () => {
        terminated = true;
      },
    });

    expect(satisfied).toBe(false);
    expect(terminated).toBe(false);
    expect(
      isAcceptedScenarioExit({
        code: null,
        signal: "SIGTERM",
        scenarioSatisfiedBeforeTermination: false,
      }),
    ).toBe(false);
  });

  test("accepts SIGTERM only when the satisfied scenario initiated it", () => {
    expect(
      isAcceptedScenarioExit({
        code: null,
        signal: "SIGTERM",
        scenarioSatisfiedBeforeTermination: true,
      }),
    ).toBe(true);
    expect(
      isAcceptedScenarioExit({
        code: 0,
        signal: null,
        scenarioSatisfiedBeforeTermination: false,
      }),
    ).toBe(true);
    expect(
      isAcceptedScenarioExit({
        code: null,
        signal: "SIGINT",
        scenarioSatisfiedBeforeTermination: true,
      }),
    ).toBe(false);
  });
});
