import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type BusyRunResult = {
  acceptedPayloads: unknown[];
  blockerCompletesAt: number;
  errors: unknown[];
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
