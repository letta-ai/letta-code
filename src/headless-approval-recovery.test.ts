import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless approval recovery wiring", () => {
  const headlessPath = fileURLToPath(new URL("./headless.ts", import.meta.url));
  const source = readFileSync(headlessPath, "utf-8");

  test("main loop pre-stream catch uses extractConflictDetail (not inline extraction)", () => {
    const start = source.indexOf("} catch (preStreamError) {");
    expect(start).toBeGreaterThan(-1);

    const end = source.indexOf(
      'if (preStreamAction === "resolve_approval_pending")',
      start,
    );
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);

    expect(segment).toContain("extractConflictDetail(preStreamError)");
    expect(segment).not.toContain("let errorDetail = ");
  });

  test("bidirectional loop pre-stream catch uses shared extraction and router (not inline)", () => {
    const firstCatch = source.indexOf("} catch (preStreamError) {");
    const secondCatch = source.indexOf(
      "} catch (preStreamError) {",
      firstCatch + 1,
    );
    expect(secondCatch).toBeGreaterThan(firstCatch);

    const throwSite = source.indexOf("throw preStreamError;", secondCatch);
    expect(throwSite).toBeGreaterThan(secondCatch);

    const segment = source.slice(secondCatch, throwSite);

    expect(segment).toContain("extractConflictDetail(preStreamError)");
    expect(segment).not.toContain("let errorDetail = ");
    expect(segment).toContain("getPreStreamErrorAction(");
    expect(segment).toContain('preStreamAction === "resolve_approval_pending"');
    expect(segment).toContain('preStreamAction === "retry_transient"');
  });

  test("main loop pre-stream uses getPreStreamErrorAction router", () => {
    const start = source.indexOf("} catch (preStreamError) {");
    const end = source.indexOf("throw preStreamError;", start);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("getPreStreamErrorAction(");
  });

  test("imports extractConflictDetail from approval-recovery", () => {
    expect(source).toContain("extractConflictDetail");
    const importBlock = source.slice(0, source.indexOf("export "));
    expect(importBlock).toContain("extractConflictDetail");
  });

  test("resume approval recovery queues stale denials instead of replaying tools", () => {
    const start = source.indexOf("let queuedRecoveredApprovalResults");
    const end = source.indexOf(
      'await resolveAllPendingApprovals("queue_for_next_turn")',
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain(
      'mode: "queue_for_next_turn" | "send_immediately" = "send_immediately"',
    );
    expect(segment).toContain("buildFreshDenialApprovals(");
    expect(segment).toContain(
      "queuedRecoveredApprovalResults = denialResults;",
    );
    expect(segment).toContain("sendScopedApprovalMessages(");
    expect(segment).not.toContain("executeApprovalBatch(");
  });

  test("recover_pending_approvals sends synthetic denials instead of rerunning approvals", () => {
    const start = source.indexOf(
      "async function recoverPendingApprovalsFromControlRequest(",
    );
    const end = source.indexOf(
      "while (true) {\n    const line = await getNextLine();",
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("buildFreshDenialApprovals(");
    expect(segment).toContain("approvalsProcessed += denialResults.length;");
    expect(segment).toContain("sendScopedApprovalMessages(");
    expect(segment).not.toContain("executeApprovalBatch(");
  });

  test("approval-only recovery sends use scoped prepared tool context", () => {
    expect(source).toContain("async function sendScopedApprovalMessages(");

    const helperStart = source.indexOf(
      "async function sendScopedApprovalMessages(",
    );
    const helperEnd = source.indexOf(
      "async function flushAndExit(",
      helperStart,
    );

    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);

    const helperSegment = source.slice(helperStart, helperEnd);
    expect(helperSegment).toContain("prepareHeadlessToolExecutionContext({");
    expect(helperSegment).toContain("conversationId: params.conversationId,");
    expect(helperSegment).toContain("preparedToolContext:");
  });

  test("invalid-ID recovery replaces stale input before retrying", () => {
    const start = source.indexOf("const invalidIdsDetected =");
    const end = source.indexOf(
      "const nonRetriableReasons: StopReasonType[]",
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain(
      "currentInput = await rebuildInputForApprovalResync(",
    );
    expect(segment).not.toContain("await resolveAllPendingApprovals();");
  });
});
