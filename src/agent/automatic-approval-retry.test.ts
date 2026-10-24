import { afterEach, describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import { __testSetBackend, type Backend, getBackend } from "@/backend";
import {
  AutomaticApprovalRetryChangedError,
  reconcileAutomaticApprovalRetry,
} from "./automatic-approval-retry";
import type { ResumeData } from "./check-approval";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "./turn-recovery-policy";

type Input = Parameters<typeof reconcileAutomaticApprovalRetry>[2];
const originalBackend = getBackend();
const message = {
  type: "message" as const,
  role: "user" as const,
  content: "keep me",
  otid: "message-identity",
};
function automatic(id = "A3"): Input[number] {
  return {
    type: "approval",
    otid: "denial-identity",
    approvals: [
      {
        type: "approval",
        tool_call_id: id,
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
    ],
  };
}
const pending = (id: string) => ({
  toolCallId: id,
  toolName: "UpdatePlan",
  toolArgs: "{}",
});
function reconcileWithPending(
  input: Input,
  readPending: () => Promise<ResumeData["pendingApprovals"]>,
  signal?: AbortSignal,
) {
  return reconcileAutomaticApprovalRetry("agent", "default", input, signal, {
    readPending,
  });
}
afterEach(() => __testSetBackend(originalBackend));

describe("automatic approval retry reconciliation", () => {
  test("does not query or rewrite ordinary messages, user decisions or real results", async () => {
    const inputs: Input[] = [
      [message],
      [
        {
          type: "approval",
          approvals: [
            {
              type: "approval",
              tool_call_id: "A3",
              approve: false,
              reason: "user refusal",
            },
          ],
        },
      ],
      [
        {
          type: "approval",
          approvals: [
            {
              type: "tool",
              tool_call_id: "A3",
              status: "success",
              tool_return: "done",
            },
          ],
        },
      ],
    ];
    for (const input of inputs) {
      expect(
        await reconcileWithPending(input, async () => {
          throw new Error("must not read");
        }),
      ).toBe(input);
    }
  });

  test("retains the entire valid batch including real results and OTIDs", async () => {
    const result: Input[number] = {
      type: "approval",
      otid: "result-identity",
      approvals: [
        {
          type: "tool",
          tool_call_id: "A1",
          status: "success",
          tool_return: "done",
        },
      ],
    };
    const input = [automatic(), result, message];
    expect(
      await reconcileWithPending(input, async () => [
        pending("A3"),
        pending("A1"),
      ]),
    ).toBe(input);
  });

  test("returns fresh pending calls to the TUI without making decisions for them", async () => {
    const snapshot = [pending("A1"), pending("A2")];
    const input = [automatic(), message];
    try {
      await reconcileWithPending(input, async () => snapshot);
      throw new Error("Expected a changed-approval error");
    } catch (error) {
      expect(error).toBeInstanceOf(AutomaticApprovalRetryChangedError);
      expect(
        (error as AutomaticApprovalRetryChangedError).pendingApprovals,
      ).toBe(snapshot);
      expect((error as AutomaticApprovalRetryChangedError).action).toBe(
        "show_pending",
      );
    }
    expect(input).toEqual([automatic(), message]);
  });

  test("keeps unsent message objects and OTIDs when all automatic denials were consumed", async () => {
    const result = await reconcileWithPending(
      [automatic(), message],
      async () => [],
    );
    expect(result).toEqual([message]);
    expect(result[0]).toBe(message);
  });

  test("never submits an empty approval-only request", async () => {
    await expect(
      reconcileWithPending([automatic()], async () => []),
    ).rejects.toMatchObject({ action: "stop", pendingApprovals: [] });
  });

  test("does not discard a real result from a partially stale mixed batch", async () => {
    const input: Input = [
      automatic(),
      {
        type: "approval",
        approvals: [
          {
            type: "tool",
            tool_call_id: "A1",
            status: "success",
            tool_return: "already executed",
          },
        ],
      },
      message,
    ];
    const before = structuredClone(input);
    await expect(
      reconcileWithPending(input, async () => [pending("A1"), pending("A2")]),
    ).rejects.toMatchObject({ action: "stop" });
    expect(input).toEqual(before);
  });

  test("detects an incomplete or duplicated approval set", async () => {
    for (const input of [[automatic()], [automatic(), automatic()]]) {
      await expect(
        reconcileWithPending(input, async () => [pending("A3"), pending("A1")]),
      ).rejects.toBeInstanceOf(AutomaticApprovalRetryChangedError);
    }
  });

  test("propagates failed reads instead of treating them as no pending approvals", async () => {
    await expect(
      reconcileWithPending([automatic(), message], async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("unavailable");
  });

  test("does not read after cancellation", async () => {
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      reconcileWithPending(
        [automatic()],
        async () => {
          throw new Error("must not read");
        },
        signal,
      ),
    ).rejects.toThrow("cancelled");
  });

  test("does not authorize a retry when cancelled during the read", async () => {
    const controller = new AbortController();
    await expect(
      reconcileWithPending(
        [automatic()],
        async () => {
          controller.abort(new Error("cancelled"));
          return [pending("A3")];
        },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  });

  test.each(["404", "empty"])(
    "a %s in-context message read is not proof of consumption",
    async (mode) => {
      __testSetBackend({
        retrieveAgent: async () => ({
          id: "agent",
          message_ids: ["message-pending"],
        }),
        retrieveMessage: async () => {
          if (mode === "404")
            throw new APIError(404, {}, "missing", new Headers());
          return [];
        },
      } as unknown as Backend);
      await expect(
        reconcileAutomaticApprovalRetry("agent", "default", [
          automatic(),
          message,
        ]),
      ).rejects.toThrow();
    },
  );

  test("the real pending-read path retains an unchanged approval batch", async () => {
    __testSetBackend({
      retrieveAgent: async () => ({
        id: "agent",
        message_ids: ["message-pending"],
      }),
      retrieveMessage: async () => [
        {
          id: "message-pending",
          message_type: "approval_request_message",
          tool_calls: [
            { tool_call_id: "A3", name: "UpdatePlan", arguments: "{}" },
          ],
        },
      ],
    } as unknown as Backend);
    const input = [automatic(), message];
    expect(
      await reconcileAutomaticApprovalRetry("agent", "default", input),
    ).toBe(input);
  });
});
