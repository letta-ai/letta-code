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
  test("approval escalation reports a run-scoped error event", () => {
    const source = readSource("../cli/helpers/approval-classification.ts");
    expect(source).toContain('"tool_loop_prevented"');
    expect(source).toContain('"tool_loop_guard:approval_required"');
    expect(source).toContain("runId: opts.runId");
  });

  test("same-batch execution blocking reports the same error type", () => {
    const source = readSource("../agent/approval-execution.ts");
    expect(source).toContain('"tool_loop_prevented"');
    expect(source).toContain('"tool_loop_guard:execution_blocked"');
    expect(source).toContain("runId: options?.runId");
  });
});
