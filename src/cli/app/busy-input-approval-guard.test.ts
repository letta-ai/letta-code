import { describe, expect, test } from "bun:test";
import { __testSetBackend, getBackend } from "@/backend";
import {
  createBusyInputApprovalGuard,
  recoverTuiPendingApprovalInput,
} from "./busy-input-approval-guard";

const busy = (id: string) =>
  `Another request (run_id=${id}) is currently being processed`;

describe("foreign approval guard for rejected TUI input", () => {
  test("preserves the existing orphan approval recovery when no foreign run owns it", async () => {
    const original = getBackend();
    const backend = Object.create(
      original,
      Object.getOwnPropertyDescriptors({
        async retrieveAgent() {
          return {
            id: "agent-test",
            tools: [],
            message_ids: ["message-stale"],
          };
        },
        async retrieveConversation() {
          return { id: "conv-test", in_context_message_ids: ["message-stale"] };
        },
        async retrieveMessage() {
          return [
            {
              id: "message-stale",
              date: new Date().toISOString(),
              message_type: "approval_request_message",
              tool_calls: [
                {
                  tool_call_id: "call-stale",
                  name: "Bash",
                  arguments: '{"command":"pwd"}',
                },
              ],
            },
          ];
        },
      }),
    );
    __testSetBackend(backend);
    try {
      const result = await recoverTuiPendingApprovalInput(
        [{ role: "user", content: "new input", otid: "original" }],
        "agent-test",
        "conv-test",
      );
      expect(result[0]).toMatchObject({
        type: "approval",
        approvals: [{ approve: false, tool_call_id: "call-stale" }],
      });
      expect(result[1]).toMatchObject({ role: "user", content: "new input" });
    } finally {
      __testSetBackend(original);
    }
  });

  test("retains user input when orphan approval lookup is unavailable", async () => {
    const original = getBackend();
    __testSetBackend(
      Object.create(
        original,
        Object.getOwnPropertyDescriptors({
          async retrieveAgent() {
            throw new Error("unavailable");
          },
        }),
      ),
    );
    try {
      expect(
        await recoverTuiPendingApprovalInput(
          [{ role: "user", content: "new input", otid: "original" }],
          "agent-test",
          "conv-test",
        ),
      ).toMatchObject([{ role: "user", content: "new input" }]);
    } finally {
      __testSetBackend(original);
    }
  });
  test("does not change orphan approval recovery without a named blocker", async () => {
    const guard = createBusyInputApprovalGuard();
    guard.noteConflict("Another request is currently being processed");
    expect(await guard.wait(new AbortController().signal)).toBe(false);
  });

  test("keeps a fixed deadline across repeated conflicts and advancing blockers", async () => {
    let clock = 0;
    const guard = createBusyInputApprovalGuard({
      now: () => clock,
      wait: async (delay) => {
        clock += delay;
      },
    });
    const signal = new AbortController().signal;
    guard.noteConflict(busy("run-first"));
    for (let i = 0; i < 60; i++) {
      guard.noteConflict(busy(`run-${i}`));
      expect(await guard.wait(signal)).toBe(true);
    }
    expect(clock).toBe(300_000);
    await expect(guard.wait(signal)).rejects.toThrow(
      "another client's approval",
    );
    guard.reset();
    expect(await guard.wait(signal)).toBe(false);
  });

  test("bounds retry attempts even when timers do not advance the clock", async () => {
    const guard = createBusyInputApprovalGuard({
      now: () => 0,
      wait: async () => {},
    });
    guard.noteConflict(busy("run-one"));
    const signal = new AbortController().signal;
    for (let i = 0; i < 60; i++) await guard.wait(signal);
    await expect(guard.wait(signal)).rejects.toThrow(
      "another client's approval",
    );
  });

  test("fails before another retry when cancellation interrupts the wait", async () => {
    const controller = new AbortController();
    const guard = createBusyInputApprovalGuard({
      wait: async (_delay, signal) => {
        controller.abort(new Error("cancelled"));
        signal.throwIfAborted();
      },
    });
    guard.noteConflict(busy("run-one"));
    await expect(guard.wait(controller.signal)).rejects.toThrow("cancelled");
    await expect(guard.wait(controller.signal)).rejects.toThrow("cancelled");
  });
});
