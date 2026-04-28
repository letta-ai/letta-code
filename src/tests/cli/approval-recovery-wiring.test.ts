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
    expect(segment).toContain("client.conversations.cancel");
  });

  test("startup and resume approval restores route through shared recovery helper", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain(
      "const recoverRestoredPendingApprovals = useCallback(",
    );
    expect(source).toContain(
      "void recoverRestoredPendingApprovals(approvals);",
    );
    expect(source).toContain("await recoverRestoredPendingApprovals(");
    expect(source).not.toContain(
      "setPendingApprovals(resumeData.pendingApprovals);",
    );

    const recoverStart = source.indexOf(
      "const recoverRestoredPendingApprovals = useCallback(",
    );
    const recoverEnd = source.indexOf("useEffect(() => {", recoverStart);
    expect(recoverStart).toBeGreaterThan(-1);
    expect(recoverEnd).toBeGreaterThan(recoverStart);

    const recoverSegment = source.slice(recoverStart, recoverEnd);
    expect(recoverSegment).toContain("const hasQueuedRealResults =");
    expect(recoverSegment).toContain("buildFreshDenialApprovals(");
    expect(recoverSegment).toContain("queueApprovalResults(staleDenials");
    expect(recoverSegment).not.toContain("queueApprovalResults(null)");
    expect(recoverSegment).not.toContain(
      "await classifyApprovals(approvals, {",
    );
    expect(recoverSegment).not.toContain("await executeAutoAllowedTools(");

    const queuedSwitchStart = source.indexOf(
      'if (action.type === "switch_conversation")',
    );
    const queuedSwitchEnd = source.indexOf(
      '} else if (action.type === "switch_toolset")',
    );
    expect(queuedSwitchStart).toBeGreaterThan(-1);
    expect(queuedSwitchEnd).toBeGreaterThan(queuedSwitchStart);

    const queuedSwitchSegment = source.slice(
      queuedSwitchStart,
      queuedSwitchEnd,
    );
    expect(queuedSwitchSegment).toContain(
      "await recoverRestoredPendingApprovals(",
    );
  });

  test("slash command recovery consumes queued stale denials on the slash send", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain(
      "const processConversationWithQueuedApprovals = useCallback(",
    );
    expect(source).toContain(
      "consumeQueuedApprovalInputForCurrentConversation();",
    );

    const slashHandlers = [
      'if (\n          trimmed === "/skill-creator"',
      'if (trimmed.startsWith("/remember")) {',
      'if (trimmed === "/init") {',
      'if (trimmed === "/doctor") {',
      'if (trimmed.startsWith("/empanada")) {',
      "if (matchedCustom) {",
    ];

    for (const startNeedle of slashHandlers) {
      const start = source.indexOf(startNeedle);
      expect(start).toBeGreaterThan(-1);

      const segment = source.slice(start, start + 7000);
      expect(segment).toContain("checkPendingApprovalsForSlashCommand()");
      expect(segment).toContain("processConversationWithQueuedApprovals([");
      expect(segment).not.toContain("await processConversation([");
    }
  });
});
