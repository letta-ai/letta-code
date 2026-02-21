import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("approval recovery wiring", () => {
  test("pre-stream catch uses shared recovery router and stale input rebuild", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const start = source.indexOf("} catch (preStreamError) {");
    const end = source.indexOf(
      "// Check again after network call - user may have pressed Escape during sendMessageStream",
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    expect(segment).toContain("extractConflictDetail(preStreamError)");
    expect(segment).toContain("getPreStreamErrorAction(");
    expect(segment).toContain("shouldAttemptApprovalRecovery(");
    expect(segment).toContain("rebuildInputWithFreshDenials(");
    expect(segment).toContain('preStreamAction === "retry_transient"');
  });

  test("lazy recovery is not gated by hasApprovalInPayload", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const start = source.indexOf("const approvalPendingDetected =");
    const end = source.indexOf("// Check if this is a retriable error");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    expect(segment).toContain("shouldAttemptApprovalRecovery(");
    expect(segment).not.toContain("!hasApprovalInPayload &&");
  });

  test("tool interrupt branch includes backend cancel call before early return", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const start = source.indexOf("if (\n      isExecutingTool");
    const end = source.indexOf("if (!streaming || interruptRequested)");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    expect(segment).toContain("getClient()");
    expect(segment).toContain("client.agents.messages.cancel");
    expect(segment).toContain("client.conversations.cancel");
  });
});
