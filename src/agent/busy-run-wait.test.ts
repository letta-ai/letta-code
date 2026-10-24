import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  waitForBlockingRunToSettle,
  waitForBusyRunRetry,
} from "./busy-run-wait";

type RetrieveRun = Backend["retrieveRun"];
const runWithStatus = (status: unknown) =>
  ({ status }) as Awaited<ReturnType<RetrieveRun>>;

describe("blocking run metadata wait", () => {
  test.each(["completed", "failed", "cancelled", "expired"])(
    "only recognized terminal status %s settles",
    async (status) => {
      expect(
        await waitForBlockingRunToSettle("foreign", undefined, {
          retrieveRun: async () => runWithStatus(status),
        }),
      ).toBe("settled");
    },
  );

  test.each([undefined, null, "unknown", "requires_approval", "paused"])(
    "status %s does not authorize immediate retry",
    async (status) => {
      expect(
        await waitForBlockingRunToSettle("foreign", undefined, {
          retrieveRun: async () => runWithStatus(status),
        }),
      ).toBe("unavailable");
    },
  );

  test("created, running and pending keep polling metadata", async () => {
    const statuses = ["created", "running", "pending", "completed"];
    const ids: string[] = [];
    expect(
      await waitForBlockingRunToSettle("foreign", undefined, {
        pollIntervalMs: 1,
        retrieveRun: async (id, options) => {
          ids.push(id);
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          expect(options?.maxRetries).toBe(0);
          expect(options?.timeout).toBeGreaterThan(0);
          return runWithStatus(statuses.shift());
        },
      }),
    ).toBe("settled");
    expect(ids).toEqual(["foreign", "foreign", "foreign", "foreign"]);
  });

  test("unavailable metadata is not settlement", async () => {
    expect(
      await waitForBlockingRunToSettle("foreign", undefined, {
        retrieveRun: async () => {
          throw new Error("404");
        },
      }),
    ).toBe("unavailable");
  });

  test("a hanging lookup times out and aborts the backend request", async () => {
    let requestSignal: AbortSignal | undefined;
    let finish!: (run: Awaited<ReturnType<RetrieveRun>>) => void;
    const pending = new Promise<Awaited<ReturnType<RetrieveRun>>>((resolve) => {
      finish = resolve;
    });
    expect(
      await waitForBlockingRunToSettle("foreign", undefined, {
        timeoutMs: 10,
        retrieveRun: async (_id, options) => {
          requestSignal = options?.signal ?? undefined;
          return pending;
        },
      }),
    ).toBe("timed_out");
    expect(requestSignal?.aborted).toBe(true);
    finish(runWithStatus("completed"));
    await Promise.resolve();
  });

  test("abort races a pending lookup and preserves cancellation identity", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by owning turn");
    let requestSignal: AbortSignal | undefined;
    const waiting = waitForBlockingRunToSettle("foreign", controller.signal, {
      retrieveRun: async (_id, options) => {
        requestSignal = options?.signal ?? undefined;
        return new Promise(() => {});
      },
    });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });

  test("abort during poll sleep prevents another read", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during sleep");
    let reads = 0;
    const waiting = waitForBlockingRunToSettle("foreign", controller.signal, {
      retrieveRun: async () => {
        reads++;
        setTimeout(() => controller.abort(reason), 1);
        return runWithStatus("running");
      },
    });
    await expect(waiting).rejects.toBe(reason);
    expect(reads).toBe(1);
  });

  test("a pre-aborted wait never reads metadata", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let reads = 0;
    await expect(
      waitForBlockingRunToSettle("foreign", controller.signal, {
        retrieveRun: async () => {
          reads++;
          return runWithStatus("completed");
        },
      }),
    ).rejects.toThrow("already cancelled");
    expect(reads).toBe(0);
  });

  test("an active run has a finite overall deadline", async () => {
    expect(
      await waitForBlockingRunToSettle("foreign", undefined, {
        timeoutMs: 10,
        pollIntervalMs: 1,
        retrieveRun: async () => runWithStatus("running"),
      }),
    ).toBe("timed_out");
  });

  test.each(["missing-id", "unknown-status", "unavailable"])(
    "%s uses cancellable fallback without claiming delivery",
    async (scenario) => {
      const controller = new AbortController();
      let reads = 0;
      const backend: Backend = new FakeHeadlessBackend("agent-busy");
      backend.retrieveRun = async () => {
        reads++;
        if (scenario === "unavailable") throw new Error("unavailable");
        return runWithStatus(undefined);
      };
      __testSetBackend(backend);
      try {
        const waiting = waitForBusyRunRetry(
          scenario === "missing-id"
            ? "Conversation is busy"
            : "Another request is currently being processed for this conversation. run_id=run-foreign",
          10_000,
          controller.signal,
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
        const reason = new Error("stop fallback");
        controller.abort(reason);
        await expect(waiting).rejects.toBe(reason);
        expect(reads).toBe(scenario === "missing-id" ? 0 : 1);
      } finally {
        __testSetBackend(null);
      }
    },
  );
});
