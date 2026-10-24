import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type BusyRunResult = {
  acceptedPayloads: unknown[];
  sentBytes: string[];
  polledRunIds: string[];
  approvalReads: number;
  cancellationTriggered: boolean;
  blockerCompletesAt: number;
  errors: unknown[];
  queueAfterFailure: Array<{
    content: unknown;
    paused?: boolean;
    clientMessageId?: string;
  }>;
  queueAfterReplay: Array<{ content: unknown }>;
  readyAfterFailure: number;
  postsAfterFailure: number;
  restoredInputs: string[];
  lastStopReason: string | null;
  resumeBodies: Array<{ otid?: string }>;
  runPolls: number;
  scenario: string;
  sentPayloads: unknown[];
  source: string;
  virtualElapsedMs: number;
};

const fixturePath = fileURLToPath(
  new URL("../../test-utils/TuiBusyRunScenario.tsx", import.meta.url),
);
const requestOtid = "33333333-3333-4333-8333-333333333333";
const userText = "Keep this new input after the blocking run finishes.";

function runScenario(scenario: string): BusyRunResult {
  const child = spawnSync(process.execPath, [fixturePath, scenario], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `The ${scenario} fixture exited ${child.status ?? "without a status"}.\n${child.stderr}`,
    );
  }
  const marker = "TUI_BUSY_RESULT=";
  const resultStart = child.stdout.lastIndexOf(marker);
  if (resultStart < 0) {
    throw new Error(
      `The ${scenario} fixture started but emitted no result JSON. ${child.stderr}`,
    );
  }
  let result: BusyRunResult;
  try {
    result = JSON.parse(
      child.stdout.slice(resultStart + marker.length).trim(),
    ) as BusyRunResult;
  } catch (error) {
    throw new Error(
      `The ${scenario} fixture emitted invalid result JSON. ${child.stdout}\n${child.stderr}`,
      { cause: error },
    );
  }
  expect(result.scenario).toBe(scenario);
  expect(result.source).toBe("useConversationLoop");
  return result;
}

function containsValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value))
    return value.some((item) => containsValue(item, expected));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsValue(item, expected));
  }
  return false;
}

function expectOriginalInputAccepted(result: BusyRunResult): void {
  expect(result.acceptedPayloads).toHaveLength(1);
  expect(result.acceptedPayloads[0]).toEqual(result.sentPayloads[0]);
  expect(containsValue(result.acceptedPayloads[0], userText)).toBe(true);
  expect(containsValue(result.acceptedPayloads[0], requestOtid)).toBe(true);
  expect(result.lastStopReason).toBe("end_turn");
  expect(result.errors).toEqual([]);
}

describe("interactive busy-run recovery", () => {
  test(
    "never requeues accepted own input if its resumed stream fails",
    () => {
      const result = runScenario("queue-own-drain-error");
      expect(result.postsAfterFailure).toBe(1);
      expect(result.sentPayloads).toHaveLength(1);
      expect(result.acceptedPayloads).toHaveLength(1);
      expect(result.acceptedPayloads[0]).toEqual(result.sentPayloads[0]);
      expect(result.queueAfterFailure.map((item) => item.content)).toEqual([
        [{ type: "text", text: "queued first" }],
        "queued second",
      ]);
      expect(result.readyAfterFailure).toBe(0);
      expect(result.restoredInputs).toEqual([]);
    },
    { timeout: 120_000 },
  );
  for (const scenario of [
    "queue-timeout",
    "queue-exhausted",
    "queue-metadata-failure",
    "queue-approval-timeout",
  ]) {
    test(
      `parks rejected input and pending queue in FIFO after ${scenario}`,
      () => {
        const result = runScenario(scenario);
        expect(result.queueAfterFailure.map((item) => item.content)).toEqual([
          userText,
          [{ type: "text", text: "queued first" }],
          "queued second",
        ]);
        expect(result.queueAfterFailure.every((item) => item.paused)).toBe(
          true,
        );
        expect(result.readyAfterFailure).toBe(0);
        expect(result.restoredInputs).toEqual([]);
        expect(result.queueAfterFailure[0]?.clientMessageId).toBe(requestOtid);
        expect(result.queueAfterReplay.map((item) => item.content)).toEqual([
          [{ type: "text", text: "queued first" }],
          "queued second",
        ]);
        expect(result.acceptedPayloads).toHaveLength(1);
        expect(result.acceptedPayloads[0]).toEqual(result.sentPayloads[0]);
        expect(result.approvalReads).toBe(0);
        expect(result.lastStopReason).toBe("end_turn");
        expect(result.postsAfterFailure).toBe(
          scenario === "queue-timeout"
            ? 1
            : scenario === "queue-approval-timeout"
              ? 62
              : 4,
        );
      },
      { timeout: 120_000 },
    );
  }
  test(
    "preserves foreign approval ownership across an advancing blocker",
    () => {
      const result = runScenario("foreign-approval");
      expectOriginalInputAccepted(result);
      expect(result.approvalReads).toBe(0);
      expect(result.sentBytes).toHaveLength(4);
      expect(new Set(result.sentBytes).size).toBe(1);
      expect(result.polledRunIds).toContain(
        "run-11111111-1111-4111-8111-111111111111",
      );
      expect(result.polledRunIds).toContain(
        "run-22222222-2222-4222-8222-222222222222",
      );
      expect(
        result.resumeBodies.every((body) => body.otid === requestOtid),
      ).toBe(true);
    },
    { timeout: 120_000 },
  );

  test(
    "cancels the pending original during another client's approval wait",
    () => {
      const result = runScenario("cancel-foreign-approval");
      expect(result.cancellationTriggered).toBe(true);
      expect(result.acceptedPayloads).toEqual([]);
      expect(result.sentPayloads).toHaveLength(2);
      expect(result.approvalReads).toBe(0);
      expect(new Set(result.sentBytes).size).toBe(1);
    },
    { timeout: 120_000 },
  );
  test(
    "retains and sends the original input once after the blocker settles",
    () => {
      const result = runScenario("busy");

      expectOriginalInputAccepted(result);
    },
    { timeout: 120_000 },
  );

  test(
    "normal send accepts its original input",
    () => {
      expectOriginalInputAccepted(runScenario("normal"));
    },
    { timeout: 120_000 },
  );

  test(
    "resumes a previously accepted own OTID without resending its input",
    () => {
      const result = runScenario("accepted-own-otid");

      expect(
        result.resumeBodies.some((body) => body.otid === requestOtid),
      ).toBe(true);
      expect(result.sentPayloads).toHaveLength(1);
      expectOriginalInputAccepted(result);
    },
    { timeout: 120_000 },
  );
});
