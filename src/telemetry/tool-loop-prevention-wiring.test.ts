import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

describe("tool loop prevention telemetry wiring", () => {
  test("approval escalation reports run-scoped prevention metadata", () => {
    const source = readSource("../cli/helpers/approval-classification.ts");
    expect(source).toContain('action: "approval_required"');
    expect(source).toContain("runId: opts.runId");
  });

  test("same-batch execution reports run-scoped prevention metadata", () => {
    const source = readSource("../agent/approval-execution.ts");
    expect(source).toContain('action: "execution_blocked"');
    expect(source).toContain("runId: options?.runId");
  });

  test("production guards send prevention events through error telemetry", () => {
    const telemetrySource = readSource("./index.ts");
    expect(telemetrySource).toContain('"tool_loop_prevented"');
    expect(telemetrySource).toContain("tool_loop_guard:");
    expect(telemetrySource).toContain("event.action");

    for (const path of [
      "../cli/app/AppCoordinator.tsx",
      "../headless.ts",
      "../websocket/listener/turn.ts",
      "../websocket/listener/recovery.ts",
    ]) {
      expect(readSource(path)).toContain(
        "onPrevention: trackToolLoopPrevention",
      );
    }
  });
});
