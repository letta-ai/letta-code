import { afterEach, describe, expect, test } from "bun:test";
import { __testSetBackend, getBackend } from "@/backend";
import { reconcileAutomaticApprovalRetry } from "./automatic-approval-retry";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "./turn-recovery-policy";

const original = getBackend();
afterEach(() => __testSetBackend(original));
const input: Parameters<typeof reconcileAutomaticApprovalRetry>[2] = [
  {
    type: "approval",
    otid: "denial",
    approvals: [
      {
        type: "approval",
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
        tool_call_id: "A3",
      },
    ],
  },
  { type: "message", role: "user", content: "unsent", otid: "message" },
];
async function observed(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error) => error,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("bounded automatic approval reads", () => {
  test("a late agent read cannot start further requests after its deadline", async () => {
    let finish!: (agent: { id: string; message_ids: string[] }) => void;
    let messageReads = 0;
    let receivedSignal: AbortSignal | undefined;
    __testSetBackend(
      Object.create(
        original,
        Object.getOwnPropertyDescriptors({
          async retrieveAgent(
            _id: string,
            _query: unknown,
            options?: { signal?: AbortSignal },
          ) {
            receivedSignal = options?.signal;
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
          async retrieveMessage() {
            messageReads++;
            return [];
          },
        }),
      ),
    );
    const result = await observed(
      reconcileAutomaticApprovalRetry("agent", "default", input, undefined, {
        timeoutMs: 10,
      }),
    );
    expect(result).toBeInstanceOf(Error);
    expect(receivedSignal?.aborted).toBe(true);
    finish({ id: "agent", message_ids: ["pending"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messageReads).toBe(0);
  });
  test.each(["agent", "conversation", "message", "history"])(
    "cancels a stalled %s read without waiting for backend settlement",
    async (stage) => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let receivedSignal: AbortSignal | undefined;
      const stall = (options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        started();
        return new Promise<never>(() => {});
      };
      __testSetBackend(
        Object.create(
          original,
          Object.getOwnPropertyDescriptors({
            async retrieveAgent(
              _id: string,
              _query: unknown,
              options?: { signal?: AbortSignal },
            ) {
              if (stage === "agent") return stall(options);
              return {
                id: "agent",
                message_ids: stage === "history" ? [] : ["pending"],
              };
            },
            async retrieveConversation(
              _id: string,
              options?: { signal?: AbortSignal },
            ) {
              return stall(options);
            },
            async retrieveMessage(
              _id: string,
              options?: { signal?: AbortSignal },
            ) {
              return stall(options);
            },
            async getConversationResumeTail(
              _agentId: string,
              _id: string,
              options?: { signal?: AbortSignal },
            ) {
              return stall(options);
            },
          }),
        ),
      );
      const controller = new AbortController();
      const result = reconcileAutomaticApprovalRetry(
        "agent",
        stage === "conversation" ? "conv" : "default",
        input,
        controller.signal,
      );
      await ready;
      const reason = new Error("cancelled promptly");
      controller.abort(reason);
      expect(await observed(result)).toBe(reason);
      expect(receivedSignal?.aborted).toBe(true);
    },
  );

  test("bounds a stalled read even without a caller abort", async () => {
    const deps = {
      timeoutMs: 10,
      readPending: async () => new Promise<never>(() => {}),
    };
    const result = await observed(
      reconcileAutomaticApprovalRetry(
        "agent",
        "default",
        input,
        undefined,
        deps,
      ),
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("timed out");
  });
});
