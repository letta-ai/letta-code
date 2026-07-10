import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the post-interrupt approval recovery (PR #2631).
 *
 * A turn cancelled mid-tool-call (while a tool awaited approval) leaves the
 * Letta agent in `requires_approval` with a dangling approval. Before this fix
 * the next in-session user turn was sent against that stale state and the run
 * errored — surfaced downstream (in the ACP adapter) as a bare "refusal" with
 * no visible output. The fix records that the prior turn was interrupted and
 * clears pending approvals (reusing resolveAllPendingApprovals) at the start of
 * the next turn, before sending.
 *
 * The behavior itself is backend-coupled and proven by scripts/cancel-tool-smoke.ts
 * (turn 2 recovers to end_turn instead of refusal). These assertions lock the
 * wiring so the recovery can't silently regress.
 */
describe("headless post-interrupt approval recovery wiring", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./headless.ts", import.meta.url)),
    "utf-8",
  );

  test("tracks whether the prior turn was interrupted", () => {
    expect(source).toContain("let priorTurnInterrupted = false;");
    // The epilogue records the interrupted state from the abort controller.
    expect(source).toContain(
      "priorTurnInterrupted = currentAbortController?.signal.aborted === true;",
    );
  });

  test("clears dangling approvals before the next turn when interrupted", () => {
    expect(source).toContain("if (priorTurnInterrupted) {");
    // It consumes the flag and runs the shared recovery primitive.
    const idx = source.indexOf("if (priorTurnInterrupted) {");
    const block = source.slice(idx, idx + 400);
    expect(block).toContain("priorTurnInterrupted = false;");
    expect(block).toContain("resolveAllPendingApprovals()");
  });
});
