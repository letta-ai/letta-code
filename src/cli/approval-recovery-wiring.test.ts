import { describe, expect, test } from "bun:test";
import { readInteractiveAppSource } from "@/test-utils/read-interactive-app-source";

describe("approval recovery wiring", () => {
  test("pre-stream catch uses shared recovery router and stale input rebuild", () => {
    const source = readInteractiveAppSource();

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
    const source = readInteractiveAppSource();

    const start = source.indexOf("const approvalPendingDetected =");
    const end = source.indexOf("// Check if this is a retriable error");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    expect(segment).toContain("shouldAttemptApprovalRecovery(");
    expect(segment).not.toContain("!hasApprovalInPayload &&");
  });

  test("local post-stream retry continues from persisted state instead of replaying input", () => {
    const source = readInteractiveAppSource();

    const start = source.indexOf("const retryFromPersistedLocalState =");
    const end = source.indexOf(
      "// Reset seq_id threshold — new run starts from seq_id 1",
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("backendCapabilities.localModelCatalog");
    expect(segment).toContain("!backendCapabilities.remoteMemfs");
    expect(segment).toContain("? []");
    expect(segment).toContain(": refreshInputOtidsForNewRequest(currentInput)");
  });

  test("tool interrupt branch includes backend cancel call before early return", () => {
    const source = readInteractiveAppSource();

    const start = source.indexOf("if (\n      isExecutingTool");
    const end = source.indexOf("if (!streaming || interruptRequested)");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    expect(segment).toContain("getBackend().cancelConversation");
  });

  test("startup and resume approval restores route through shared recovery helper", () => {
    const source = readInteractiveAppSource();

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
    expect(recoverSegment).toContain(
      "await restorePendingApprovalUi(approvals)",
    );
    expect(recoverSegment).not.toContain("buildFreshDenialApprovals(");
    expect(recoverSegment).not.toContain("queueApprovalResults(staleDenials");
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
    const source = readInteractiveAppSource();

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

  test("/btw side-question flow routes pre-stream approval conflicts through shared recovery helpers", () => {
    const source = readInteractiveAppSource();

    const start = source.indexOf("const handleBtwCommand = useCallback(");
    const end = source.indexOf("const handleBtwJump = useCallback(", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    expect(segment).toContain(
      "await sendMessageStream(forked.id, currentInput",
    );
    expect(segment).not.toContain(
      "getBackend().createConversationMessageStream(",
    );
    expect(segment).toContain("extractConflictDetail(preStreamError)");
    expect(segment).toContain("getPreStreamErrorAction(");
    expect(segment).toContain("shouldAttemptApprovalRecovery(");
    expect(segment).toContain("rebuildInputWithFreshDenials(");
    expect(segment).toContain(
      "await getResumeDataFromBackend(agent, forked.id)",
    );
  });
});
