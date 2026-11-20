import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { telemetry } from "./index";
import {
  classifyWorkerFailure,
  EXTERNAL_WORKER_TURN_FAILED,
  reportDiskFullIfDetected,
  reportExternalWorkerTurnFailure,
  resetFailureRateLimitForTest,
  SANDBOX_DISK_FULL,
} from "./sandbox-failure-reporting";

describe("sandbox failure reporting", () => {
  let trackError: ReturnType<typeof spyOn>;
  beforeEach(() => {
    resetFailureRateLimitForTest();
    trackError = spyOn(telemetry, "trackError").mockImplementation(() => {});
    spyOn(telemetry, "flush").mockResolvedValue(undefined);
  });
  afterEach(() => {
    (
      telemetry.trackError as unknown as { mockRestore: () => void }
    ).mockRestore();
    (telemetry.flush as unknown as { mockRestore: () => void }).mockRestore();
  });

  function reportedContext(call = 0): Record<string, unknown> {
    return JSON.parse(trackError.mock.calls[call]?.[2] as string);
  }

  test("reports a failed worker turn once per conversation and reason, without the message", () => {
    const failure = {
      harness: "codex",
      error:
        "Codex runtime failed: Broken pipe (os error 32) at /home/me/secret",
      agentId: "agent-1",
      conversationId: "conv-1",
    };
    reportExternalWorkerTurnFailure(failure);
    reportExternalWorkerTurnFailure(failure);
    expect(trackError).toHaveBeenCalledTimes(1);
    expect(trackError.mock.calls[0]?.[0]).toBe(EXTERNAL_WORKER_TURN_FAILED);
    const context = reportedContext();
    expect(context).toMatchObject({
      reason: "broken_pipe",
      harness: "codex",
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    expect(JSON.stringify(trackError.mock.calls[0])).not.toContain("secret");

    reportExternalWorkerTurnFailure({ ...failure, conversationId: "conv-2" });
    expect(trackError).toHaveBeenCalledTimes(2);
  });

  test("skips aborted worker turns", () => {
    reportExternalWorkerTurnFailure({
      harness: "claude-code",
      error: "The operation was aborted",
    });
    expect(trackError).not.toHaveBeenCalled();
  });

  test("classifies common worker deaths", () => {
    expect(classifyWorkerFailure("write EPIPE")).toBe("broken_pipe");
    expect(classifyWorkerFailure("ENOSPC: no space left on device")).toBe(
      "disk_full",
    );
    expect(
      classifyWorkerFailure(
        "Claude Code exited before a final result with 137",
      ),
    ).toBe("exited");
  });

  test("reports disk-full only when the disk really is nearly full", () => {
    const output = "npm ERR! code ENOSPC\nnpm ERR! no space left on device";
    reportDiskFullIfDetected({
      toolName: "Bash",
      output,
      conversationId: "conv-1",
      readSize: () => ({ disk_used_percent: 40, disk_total_gb: 10 }),
    });
    expect(trackError).not.toHaveBeenCalled();

    reportDiskFullIfDetected({
      toolName: "Bash",
      output,
      conversationId: "conv-1",
      readSize: () => ({ disk_used_percent: 99, disk_total_gb: 10 }),
    });
    expect(trackError).toHaveBeenCalledTimes(1);
    expect(trackError.mock.calls[0]?.[0]).toBe(SANDBOX_DISK_FULL);
    expect(reportedContext()).toMatchObject({
      tool_name: "Bash",
      conversation_id: "conv-1",
      disk_used_percent: 99,
      disk_total_gb: 10,
    });
    expect(JSON.stringify(trackError.mock.calls[0])).not.toContain("npm ERR");
  });

  test("ignores tool output without a disk-full error", () => {
    reportDiskFullIfDetected({
      toolName: "Bash",
      output: "done",
      readSize: () => ({ disk_used_percent: 99 }),
    });
    expect(trackError).not.toHaveBeenCalled();
  });
});
