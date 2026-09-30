import { expect, test } from "bun:test";
import type { ControlRequest } from "@/types/app-server-protocol";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  makeStreamDelta,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";

function approval(
  requestId: string,
  conversationId = "conv-1",
): ControlRequest {
  return {
    type: "control_request",
    agent_id: "agent-1",
    conversation_id: conversationId,
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      tool_call_id: `call-${requestId}`,
      input: { command: "ls" },
      permission_suggestions: [],
      blocked_path: null,
    },
  };
}

test.each(["telegram", "slack"])(
  "%s cancellation includes late same-turn handoffs without discarding other runtimes or newer approvals",
  async (channel) => {
    const progressStarted = Promise.withResolvers<void>();
    const releaseProgress = Promise.withResolvers<void>();
    const abort = Promise.withResolvers<boolean>();
    const deliveredNew = Promise.withResolvers<void>();
    const deliveredOther = Promise.withResolvers<void>();
    const delivered: string[] = [];
    const cleared: string[] = [];
    const client = new FakeClient();
    const gateway = new ChannelGateway(
      client,
      makeHooks({
        onProgress: async () => {
          progressStarted.resolve();
          await releaseProgress.promise;
        },
        onControlRequest: (event) => {
          delivered.push(event.requestId);
          if (event.requestId === "new") deliveredNew.resolve();
          if (event.requestId === "other") deliveredOther.resolve();
        },
      }).hooks,
    );
    try {
      await gateway.submit(
        makeDelivery({ sources: [makeSource({ channel })] }),
      );
      client.emit(makeStreamDelta({ message_type: "reasoning_message" }));
      await progressStarted.promise;
      client.emit(approval("old"));
      const cancelling = gateway.cancelControlHandoffs(
        TEST_RUNTIME,
        () => abort.promise,
        (id) => cleared.push(id),
      );
      client.emit(approval("same-turn-late"));
      client.emit(makeTurnFinished("cancelled"));
      await gateway.submit(
        makeDelivery({
          clientMessageId: "new-turn",
          sources: [makeSource({ channel })],
        }),
      );
      client.emit(approval("new"));
      const otherRuntime = {
        agent_id: "agent-1",
        conversation_id: "conv-other",
      };
      await gateway.submit(
        makeDelivery({
          runtime: otherRuntime,
          clientMessageId: "other-turn",
          sources: [makeSource({ channel, conversationId: "conv-other" })],
        }),
      );
      client.emit(approval("other", "conv-other"));
      await deliveredOther.promise;
      abort.resolve(true);
      expect(await cancelling).toBe(true);
      expect(cleared).toEqual(["old", "same-turn-late"]);
      expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
      releaseProgress.resolve();
      await deliveredNew.promise;
      expect(delivered).toEqual(["other", "new"]);
      expect(
        cleared.every((id) => id === "old" || id === "same-turn-late"),
      ).toBe(true);
    } finally {
      releaseProgress.resolve();
      abort.resolve(false);
      gateway.close();
    }
  },
);

test.each(["resolve", "reject"])(
  "cancellation during approval delivery clears again after %s and releases cleanup guard",
  async (settlement) => {
    const deliveryStarted = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const cleared: string[] = [];
    const client = new FakeClient();
    const gateway = new ChannelGateway(
      client,
      makeHooks({
        onControlRequest: async () => {
          deliveryStarted.resolve();
          await releaseDelivery.promise;
          if (settlement === "reject") throw new Error("delivery failed");
        },
        onLifecycle: (event) => {
          if (event.type === "finished") finished.resolve();
        },
      }).hooks,
    );
    try {
      await gateway.submit(makeDelivery());
      client.emit(approval("in-flight"));
      await deliveryStarted.promise;
      await gateway.cancelControlHandoffs(
        TEST_RUNTIME,
        async () => true,
        (id) => cleared.push(id),
      );
      client.emit(makeTurnFinished("cancelled"));
      gateway.setRoutedSources(TEST_RUNTIME, []);
      expect(cleared).toEqual(["in-flight"]);
      expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
      await expect(
        gateway.releaseRuntimeTools(TEST_RUNTIME, [], {
          cleanupIdleRuntime: true,
        }),
      ).rejects.toThrow("active");
      releaseDelivery.resolve();
      await finished.promise;
      expect(cleared).toEqual(["in-flight", "in-flight"]);
      expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
      await gateway.releaseRuntimeTools(TEST_RUNTIME, [], {
        cleanupIdleRuntime: true,
      });
      expect(gateway.getKnownRuntimes()).toEqual([]);
    } finally {
      releaseDelivery.resolve();
      gateway.close();
    }
  },
);

test.each(["telegram", "slack"])(
  "%s overlapping aborts retain late delivered handoffs until acknowledgment",
  async (channel) => {
    const client = new FakeClient();
    const pending = new Set<string>();
    const delivered = Promise.withResolvers<void>();
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const gateway = new ChannelGateway(
      client,
      makeHooks({
        onControlRequest: (event) => {
          pending.add(event.requestId);
          delivered.resolve();
        },
      }).hooks,
    );
    try {
      await gateway.submit(
        makeDelivery({ sources: [makeSource({ channel })] }),
      );
      const cancel = (result: Promise<boolean>) =>
        gateway.cancelControlHandoffs(
          TEST_RUNTIME,
          () => result,
          (id) => {
            pending.delete(id);
          },
        );
      const cancellingFirst = cancel(first.promise);
      const cancellingSecond = cancel(second.promise);
      client.emit(approval("same-turn-late"));
      await delivered.promise;
      client.emit(makeTurnFinished("cancelled"));
      first.resolve(false);
      expect(await cancellingFirst).toBe(false);
      expect(pending.has("same-turn-late")).toBe(true);
      second.resolve(true);
      expect(await cancellingSecond).toBe(true);
      expect(pending.size).toBe(0);
      expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
    } finally {
      first.resolve(false);
      second.resolve(false);
      gateway.close();
    }
  },
);

test.each([false, "throw"])(
  "failed cancellation (%s) preserves a queued handoff",
  async (outcome) => {
    const progressStarted = Promise.withResolvers<void>();
    const releaseProgress = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const cleared: string[] = [];
    const client = new FakeClient();
    const gateway = new ChannelGateway(
      client,
      makeHooks({
        onProgress: async () => {
          progressStarted.resolve();
          await releaseProgress.promise;
        },
        onControlRequest: () => delivered.resolve(),
      }).hooks,
    );
    try {
      await gateway.submit(makeDelivery());
      client.emit(makeStreamDelta({ message_type: "reasoning_message" }));
      await progressStarted.promise;
      client.emit(approval("pending"));
      const cancelling = gateway.cancelControlHandoffs(
        TEST_RUNTIME,
        async () => {
          if (outcome === "throw") throw new Error("abort failed");
          return false;
        },
        (id) => cleared.push(id),
      );
      if (outcome === "throw")
        await expect(cancelling).rejects.toThrow("abort failed");
      else expect(await cancelling).toBe(false);
      releaseProgress.resolve();
      await delivered.promise;
      expect(cleared).toEqual([]);
    } finally {
      releaseProgress.resolve();
      gateway.close();
    }
  },
);
