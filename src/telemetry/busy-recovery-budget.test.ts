import { describe, expect, test } from "bun:test";
import { BusyRecoveryBudget } from "./busy-recovery-budget";

describe("busy diagnostic volume budget", () => {
  test("deduplicates retry phases and links rotating blockers to one request", () => {
    const budget = new BusyRecoveryBudget();
    let accepted = 0;
    for (let n = 0; n < 1000; n += 1) {
      const fields = {
        conversationId: "conv-example",
        otid: "otid-example",
        blockerRunId: `run-${n}`,
      };
      accepted += Number(budget.allow("send_rejected", fields, 0));
      accepted += Number(
        budget.allow("poll_started", { blockerRunId: fields.blockerRunId }, 0),
      );
    }
    expect(accepted).toBe(2);
  });
  test("caps an incident but reserves snapshots and eventual outcomes", () => {
    const budget = new BusyRecoveryBudget();
    const fields = { otid: "otid-example" };
    let accepted = 0;
    for (let n = 0; n < 100; n += 1)
      accepted += Number(budget.allow(`phase-${n}`, fields, 0));
    expect(accepted).toBe(8);
    expect(budget.allow("stream_progress", fields, 0)).toBe(true);
    expect(budget.allow("stream_waiting", fields, 0)).toBe(true);
    expect(budget.allow("poll_timed_out", fields, 0)).toBe(true);
    expect(budget.allow("stream_eof", fields, 0)).toBe(true);
    expect(budget.allow("stream_failed", fields, 0)).toBe(false);
  });
  test("process ceiling bounds incident churn and retains terminal capacity", () => {
    const budget = new BusyRecoveryBudget();
    let accepted = 0;
    for (let n = 0; n < 1000; n += 1)
      accepted += Number(
        budget.allow("send_rejected", { otid: `otid-${n}` }, 0),
      );
    expect(accepted).toBe(60);
    expect(budget.allow("stream_progress", { otid: "last" }, 0)).toBe(true);
    expect(budget.allow("stream_eof", { otid: "last" }, 0)).toBe(true);
    expect(budget.allow("send_rejected", { otid: "next-window" }, 120000)).toBe(
      true,
    );
  });
});
