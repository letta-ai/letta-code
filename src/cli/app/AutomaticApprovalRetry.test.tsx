import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Input = Array<{ type?: string; otid?: string; content?: unknown }>;
type Result = {
  sentPayloads: Input[];
  acceptedPayloads: Input[];
  shownApprovals: Array<{ toolCallId: string }> | null;
  restoredInput: string | null;
  lastStopReason: string | null;
  queueAfterReplay: Array<{ content?: unknown }>;
  cancellationTriggered: boolean;
  pendingReadAborted: boolean;
};

const fixture = fileURLToPath(
  new URL("../../test-utils/TuiBusyRunScenario.tsx", import.meta.url),
);
function run(scenario: string): Result {
  const child = spawnSync(process.execPath, [fixture, scenario], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Fixture failed: ${child.stderr}`);
  const marker = "TUI_BUSY_RESULT=";
  const index = child.stdout.lastIndexOf(marker);
  if (index < 0) throw new Error(`Missing fixture result: ${child.stderr}`);
  return JSON.parse(child.stdout.slice(index + marker.length));
}

describe("automatic approval recovery after a busy conflict", () => {
  test("cancellation releases a stalled real-hook pending read without another POST", () => {
    const result = run("approval-cancel-read");
    expect(result.sentPayloads).toHaveLength(2);
    expect(result.acceptedPayloads).toHaveLength(0);
    expect(result.cancellationTriggered).toBe(true);
    expect(result.pendingReadAborted).toBe(true);
  }, 60_000);
  test.each(["approval-empty-prestream", "approval-empty-sse"])(
    "keeps #5236 plain-message retry when pending clears at %s",
    (scenario) => {
      const result = run(scenario);
      expect(result.sentPayloads).toHaveLength(3);
      expect(result.lastStopReason).toBe("end_turn");
      const accepted = result.acceptedPayloads[0];
      if (!accepted) throw new Error("No accepted plain-message retry");
      expect(accepted.some((item) => item.type === "approval")).toBe(false);
      expect(accepted.map((item) => item.content)).toEqual(
        result.sentPayloads[1]
          ?.filter((item) => item.type === "message")
          .map((item) => item.content) ?? [],
      );
    },
    60_000,
  );
  test("recovers from SSE approval errors without run error metadata", () => {
    const result = run("approval-sse-only");
    expect(result.sentPayloads).toHaveLength(2);
    expect(
      result.shownApprovals?.map((approval) => approval.toolCallId),
    ).toEqual(["A1", "A2"]);
    expect(result.restoredInput).toBe(
      "Keep this new input after the blocking run finishes.",
    );
  }, 60_000);

  test("shows fresh approvals without POSTing the obsolete denial again", () => {
    const result = run("approval-changed");
    expect(result.sentPayloads).toHaveLength(2);
    expect(
      result.shownApprovals?.map((approval) => approval.toolCallId),
    ).toEqual(["A1", "A2"]);
    expect(result.acceptedPayloads).toEqual([]);
    expect(result.restoredInput).toBe(
      "Keep this new input after the blocking run finishes.",
    );
  }, 60_000);

  test("keeps a still-pending denial and its message identity intact", () => {
    const result = run("approval-stable");
    expect(result.sentPayloads).toHaveLength(3);
    expect(result.sentPayloads[2]).toEqual(result.sentPayloads[1]);
    const input = result.sentPayloads[1];
    if (!input) throw new Error("Missing denied input");
    expect(result.acceptedPayloads).toEqual([input]);
    expect(result.lastStopReason).toBe("end_turn");
  }, 60_000);

  test("removes consumed automatic denials but preserves the unsent message", () => {
    const result = run("approval-cleared");
    const message = result.sentPayloads[1]?.filter(
      (item) => item.type === "message",
    );
    if (!message) throw new Error("Missing original message");
    expect(result.acceptedPayloads).toEqual([message]);
    expect(result.lastStopReason).toBe("end_turn");
  }, 60_000);

  test("does not POST again when the pending-approval read fails", () => {
    const result = run("approval-read-failed");
    expect(result.sentPayloads).toHaveLength(2);
    expect(result.acceptedPayloads).toEqual([]);
    expect(result.lastStopReason).not.toBe("end_turn");
    expect(result.restoredInput).toBeNull();
    const rejected = result.sentPayloads[1];
    if (!rejected) throw new Error("Missing rejected input");
    expect(result.queueAfterReplay.map((item) => item.content)).toEqual(
      rejected
        .filter((item) => item.type === "message")
        .map((item) => item.content),
    );
  }, 60_000);
});
