import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { getBackend } from "@/backend";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";
import type { ListenerTransport } from "./transport";

const busyError = new APIError(
  409,
  {
    error: {
      code: "CONVERSATION_BUSY",
      detail:
        "Cannot send a new message: Another request is currently being processed for this conversation.",
    },
  },
  undefined,
  new Headers(),
);

const transport: ListenerTransport = {
  kind: "local",
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

function busyBackend(lockClearsAt: number, onWait?: () => void) {
  let elapsed = 0;
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  spyOn(performance, "now").mockImplementation(() => elapsed);
  spyOn(globalThis, "setTimeout").mockImplementation(((
    ...[callback, delay, ...args]: Parameters<typeof setTimeout>
  ) => {
    if (typeof delay !== "number" || delay < 1_000) {
      return realSetTimeout(callback, delay, ...args);
    }
    delays.push(delay);
    return realSetTimeout(() => {
      elapsed += delay;
      onWait?.();
      callback(...args);
    }, 0);
  }) as typeof setTimeout);

  const backend = getBackend();
  const submit = spyOn(
    backend,
    "createConversationMessageStream",
  ).mockImplementation(async () => {
    if (elapsed < lockClearsAt) {
      throw busyError;
    }
    return new Stream<LettaStreamingResponse>(
      () => ({ next: async () => ({ done: true, value: undefined }) }),
      new AbortController(),
    );
  });
  spyOn(backend, "streamConversationMessages").mockImplementation(async () => {
    elapsed += 1_000;
    throw new Error("Stream unavailable");
  });
  const retrieveRun = spyOn(backend, "retrieveRun");

  return { delays, submit, retrieveRun, elapsed: () => elapsed };
}

function sendTurn(
  kind: "message" | "approval",
  abortController = new AbortController(),
  authorityGuard?: () => boolean,
) {
  const conversationId = "conv-busy-lock";
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-busy-lock",
    conversationId,
  );
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
    abortController,
  });
  const options = {
    skillSources: [],
    preparedToolContext: {
      contextId: "busy-lock-test",
      clientTools: [],
      loadedToolNames: [],
    },
  };
  if (kind === "approval") {
    return sendApprovalContinuationWithRetry(
      conversationId,
      [{ type: "approval", approvals: [] }],
      options,
      transport,
      runtime,
      lease,
      { authorityGuard },
    );
  }
  return sendMessageStreamWithRetry(
    conversationId,
    [{ type: "message", role: "user", content: "hello" }],
    options,
    transport,
    runtime,
    lease,
    { authorityGuard },
  );
}

afterEach(() => {
  mock.restore();
});

describe.each(["message", "approval"] as const)(
  "%s send with a busy lock",
  (kind) => {
    test("keeps retrying until a long-held lock clears", async () => {
      const backend = busyBackend(260_000);

      await sendTurn(kind);

      expect(backend.elapsed()).toBeGreaterThanOrEqual(260_000);
      expect(backend.elapsed()).toBeLessThan(300_000);
      expect(backend.submit.mock.calls.length).toBeGreaterThan(4);
      expect(backend.delays.slice(0, 4)).toEqual([
        10_000, 20_000, 30_000, 30_000,
      ]);
      expect(backend.retrieveRun).not.toHaveBeenCalled();
    });

    test("clamps the final wait and throws the busy error at the deadline", async () => {
      const backend = busyBackend(Infinity);

      await expect(sendTurn(kind)).rejects.toBe(busyError);

      expect(backend.elapsed()).toBe(300_000);
      expect(backend.delays.at(-1)).toBeLessThan(30_000);
      expect(backend.submit).toHaveBeenCalledTimes(backend.delays.length);
      expect(backend.retrieveRun).not.toHaveBeenCalled();
    });

    test("stops waiting when aborted", async () => {
      const controller = new AbortController();
      const backend = busyBackend(Infinity, () => controller.abort());

      await expect(sendTurn(kind, controller)).rejects.toThrow(
        "Cancelled by user",
      );
      expect(backend.submit).toHaveBeenCalledTimes(1);
    });

    test("does not resubmit after losing authority while waiting", async () => {
      let ownsTurn = true;
      const backend = busyBackend(Infinity, () => {
        ownsTurn = false;
      });

      await expect(sendTurn(kind, undefined, () => ownsTurn)).rejects.toThrow(
        "Recovery ownership lost",
      );
      expect(backend.submit).toHaveBeenCalledTimes(1);
    });
  },
);
