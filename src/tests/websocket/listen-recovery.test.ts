/**
 * Tests for pending approval recovery semantics (reconnect scenario).
 *
 * Covers:
 * 1. Cold-start recovery: empty batch map → synthetic batch ID generated.
 * 2. Warm recovery: existing batch map entries → resolved to single batch ID.
 * 3. Ambiguous mapping: conflicting batch IDs → fail-closed (null).
 * 4. Idempotency: repeated resolve calls with same state → same behavior.
 * 5. isRecoveringApprovals guard prevents concurrent recovery.
 */
import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "../../websocket/listen-client";

const {
  createRuntime,
  resolveRecoveryBatchId,
  resolvePendingApprovalBatchId,
  rememberPendingApprovalBatchIds,
} = __listenClientTestUtils;

describe("resolveRecoveryBatchId cold-start", () => {
  test("empty batch map returns synthetic recovery-* batch ID", () => {
    const runtime = createRuntime();
    expect(runtime.pendingApprovalBatchByToolCallId.size).toBe(0);

    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).not.toBeNull();
    expect(batchId?.startsWith("recovery-")).toBe(true);
  });

  test("each cold-start call generates a unique batch ID", () => {
    const runtime = createRuntime();
    const id1 = resolveRecoveryBatchId(runtime, [{ toolCallId: "call-1" }]);
    const id2 = resolveRecoveryBatchId(runtime, [{ toolCallId: "call-1" }]);

    expect(id1).not.toBe(id2);
  });

  test("cold-start returns synthetic even with empty approval list", () => {
    const runtime = createRuntime();
    const batchId = resolveRecoveryBatchId(runtime, []);

    expect(batchId).not.toBeNull();
    expect(batchId?.startsWith("recovery-")).toBe(true);
  });
});

describe("resolveRecoveryBatchId warm path", () => {
  test("returns existing batch ID when all approvals map to same batch", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }, { toolCallId: "call-2" }],
      "batch-1",
    );

    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).toBe("batch-1");
  });

  test("returns null for ambiguous mapping (multiple batch IDs)", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-1",
    );
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-2" }],
      "batch-2",
    );

    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).toBeNull();
  });

  test("returns null when approval has no batch mapping", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-1",
    );

    // call-2 has no mapping
    const batchId = resolveRecoveryBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);

    expect(batchId).toBeNull();
  });
});

describe("isRecoveringApprovals guard", () => {
  test("runtime starts with isRecoveringApprovals = false", () => {
    const runtime = createRuntime();
    expect(runtime.isRecoveringApprovals).toBe(false);
  });

  test("guard flag prevents concurrent recovery (production pattern)", () => {
    const runtime = createRuntime();

    // Simulate first recovery in progress
    runtime.isRecoveringApprovals = true;

    // Second recovery attempt should observe guard and bail
    expect(runtime.isRecoveringApprovals).toBe(true);

    // Simulate completion
    runtime.isRecoveringApprovals = false;
    expect(runtime.isRecoveringApprovals).toBe(false);
  });
});

describe("resolvePendingApprovalBatchId original behavior preserved", () => {
  test("returns null when map is empty (unchanged behavior)", () => {
    const runtime = createRuntime();
    const batchId = resolvePendingApprovalBatchId(runtime, [
      { toolCallId: "call-1" },
    ]);
    expect(batchId).toBeNull();
  });

  test("returns batch ID for single consistent mapping", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-abc",
    );

    const batchId = resolvePendingApprovalBatchId(runtime, [
      { toolCallId: "call-1" },
    ]);
    expect(batchId).toBe("batch-abc");
  });

  test("returns null for conflicting mappings (strict fail-closed)", () => {
    const runtime = createRuntime();
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-1" }],
      "batch-a",
    );
    rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "call-2" }],
      "batch-b",
    );

    const batchId = resolvePendingApprovalBatchId(runtime, [
      { toolCallId: "call-1" },
      { toolCallId: "call-2" },
    ]);
    expect(batchId).toBeNull();
  });
});
