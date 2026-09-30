import { expect, test } from "bun:test";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeQueueUpdate,
  makeSource,
  makeStreamDelta,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";

test("runtime stays busy from synchronous submission until terminal completion", async () => {
  const client = new FakeClient();
  const gateway = new ChannelGateway(client, makeHooks().hooks);
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
  const submission = gateway.submit(makeDelivery());
  // Even before the submission queue microtask runs, /new must not rotate it.
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
  await submission;
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
  expect(
    gateway.isRuntimeBusy({ ...TEST_RUNTIME, conversation_id: "other" }),
  ).toBe(false);
  client.emit(
    makeStreamDelta({ message_type: "stop_reason", stop_reason: "end_turn" }),
  );
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
  client.emit(makeTurnFinished("end_turn"));
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
  gateway.close();
});

test("queued work blocks reset even without an active turn", async () => {
  const client = new FakeClient({ inputResponse: { disposition: "queued" } });
  const gateway = new ChannelGateway(client, makeHooks().hooks);
  await gateway.submit(makeDelivery());
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
  client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "cm-test-1", disposition: "cancelled" },
    ]),
  );
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
  gateway.close();
});

test("rejected submissions do not leave the runtime permanently busy", async () => {
  const client = new FakeClient({ inputResponse: { accepted: false } });
  const gateway = new ChannelGateway(client, makeHooks().hooks);
  expect(await gateway.submit(makeDelivery())).toBe(false);
  expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
  gateway.close();
});

test.each([
  { channel: "telegram", failure: "none", stopReason: "end_turn" },
  { channel: "telegram", failure: "throw", stopReason: "cancelled" },
  { channel: "telegram", failure: "reject", stopReason: "llm_api_error" },
  { channel: "slack", failure: "none", stopReason: "end_turn" },
  { channel: "slack", failure: "throw", stopReason: "cancelled" },
  { channel: "slack", failure: "reject", stopReason: "llm_api_error" },
])(
  "control handoffs stay busy until all hooks settle: %j",
  async ({ channel, failure, stopReason }) => {
    const client = new FakeClient();
    const progressStarted = Promise.withResolvers<void>();
    const releaseProgress = Promise.withResolvers<void>();
    const controlStarted = Promise.withResolvers<void>();
    const releaseControl = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const delivered: string[] = [];
    const gateway = new ChannelGateway(
      client,
      makeHooks({
        onProgress: () => {
          progressStarted.resolve();
          return releaseProgress.promise;
        },
        onControlRequest: (event) => {
          delivered.push(event.requestId);
          if (event.requestId === "ctrl-first") {
            if (failure === "throw")
              throw new Error("synchronous hook failure");
            if (failure === "reject")
              return Promise.reject(new Error("async hook failure"));
            return;
          }
          controlStarted.resolve();
          return releaseControl.promise;
        },
        onLifecycle: (event) => {
          if (event.type === "finished") finished.resolve();
        },
      }).hooks,
    );
    try {
      await gateway.submit(
        makeDelivery({ sources: [makeSource({ channel })] }),
      );
      client.emit(makeStreamDelta({ message_type: "reasoning_message" }));
      await progressStarted.promise;
      for (const requestId of ["ctrl-first", "ctrl-second"]) {
        client.emit({
          type: "control_request",
          request_id: requestId,
          agent_id: TEST_RUNTIME.agent_id,
          conversation_id: TEST_RUNTIME.conversation_id,
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            input: {},
            tool_call_id: requestId,
            permission_suggestions: [],
            blocked_path: null,
          },
        });
      }
      client.emit(makeTurnFinished(stopReason));
      expect(delivered).toEqual([]);
      expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
      gateway.setRoutedSources(TEST_RUNTIME, []);
      await expect(
        gateway.releaseRuntimeTools(TEST_RUNTIME, [], {
          cleanupIdleRuntime: true,
        }),
      ).rejects.toThrow("active");
      releaseProgress.resolve();
      await controlStarted.promise;
      expect(delivered).toEqual(["ctrl-first", "ctrl-second"]);
      // Settling the first handoff must not release the second one's reservation.
      expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(true);
      releaseControl.resolve();
      await finished.promise;
      expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
      await gateway.releaseRuntimeTools(TEST_RUNTIME, [], {
        cleanupIdleRuntime: true,
      });
      expect(gateway.getKnownRuntimes()).toEqual([]);
    } finally {
      releaseProgress.resolve();
      releaseControl.resolve();
      gateway.close();
    }
  },
);

test("failed runtime registration releases the submission busy guard", async () => {
  const client = new FakeClient({
    startResponse: { success: false, error: "registration failed" },
  });
  const gateway = new ChannelGateway(client, makeHooks().hooks);
  try {
    await expect(gateway.submit(makeDelivery())).rejects.toThrow(
      "registration failed",
    );
    expect(gateway.isRuntimeBusy(TEST_RUNTIME)).toBe(false);
  } finally {
    gateway.close();
  }
});

test("stream stop reason waits for turn_finished error detail", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents, progressEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-stream" }));

  client.emit(
    makeStreamDelta({
      message_type: "reasoning_message",
      run_id: "run-1",
    }),
  );
  await Bun.sleep(0);
  expect(progressEvents.length).toBeGreaterThan(0);

  client.emit(
    makeStreamDelta({
      message_type: "stop_reason",
      stop_reason: "insufficient_credits",
      run_id: "run-1",
    }),
  );
  await Bun.sleep(0);
  expect(
    lifecycleEvents.filter((event) => event.type === "finished"),
  ).toHaveLength(0);

  client.emit(
    makeTurnFinished("insufficient_credits", TEST_RUNTIME, {
      runId: "run-1",
      error: "The usage limit has been reached.",
    }),
  );
  await Bun.sleep(0);

  const finishedEvents = lifecycleEvents.filter(
    (event) => event.type === "finished",
  );
  expect(finishedEvents).toHaveLength(1);
  expect(finishedEvents[0]).toMatchObject({
    outcome: "error",
    stopReason: "insufficient_credits",
    runId: "run-1",
    error: "The usage limit has been reached.",
  });

  gateway.close();
});

test("run-level error stop waits for the final turn_finished event", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-retry" }));
  client.emit(
    makeStreamDelta({
      message_type: "loop_error",
      message: "temporary provider failure",
      is_terminal: false,
      run_id: "run-failed",
    }),
  );
  client.emit(
    makeStreamDelta({
      message_type: "stop_reason",
      stop_reason: "llm_api_error",
      run_id: "run-failed",
    }),
  );
  expect(lifecycleEvents.filter((event) => event.type === "finished")).toEqual(
    [],
  );

  client.emit(
    makeTurnFinished("end_turn", TEST_RUNTIME, { runId: "run-retry" }),
  );
  await Bun.sleep(0);

  const finished = lifecycleEvents.find((event) => event.type === "finished");
  expect(finished).toMatchObject({
    outcome: "completed",
    runId: "run-retry",
    stopReason: "end_turn",
  });
  expect(finished).not.toHaveProperty("error");
  gateway.close();
});

test("subagent stop does not finish or overwrite the parent turn", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-subagent" }));
  client.emit({
    ...makeStreamDelta({
      message_type: "stop_reason",
      stop_reason: "insufficient_credits",
      run_id: "run-subagent",
    }),
    subagent_id: "subagent-1",
  });
  expect(lifecycleEvents.filter((event) => event.type === "finished")).toEqual(
    [],
  );

  client.emit(
    makeTurnFinished("end_turn", TEST_RUNTIME, { runId: "run-parent" }),
  );
  await Bun.sleep(0);

  const finished = lifecycleEvents.find((event) => event.type === "finished");
  expect(finished).toMatchObject({
    outcome: "completed",
    runId: "run-parent",
    stopReason: "end_turn",
  });
  gateway.close();
});

test("requires_approval stop reason does not finish the turn", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-approval" }));

  // Emit a requires_approval stop_reason
  client.emit(
    makeStreamDelta({
      message_type: "stop_reason",
      stop_reason: "requires_approval",
      run_id: "run-1",
    }),
  );

  // Should NOT trigger finished lifecycle
  const finishedEvents = lifecycleEvents.filter((e) => e.type === "finished");
  expect(finishedEvents).toHaveLength(0);

  gateway.close();
});

test("terminal requires_approval recovery event clears the active turn", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-recovery" }));
  client.emit(
    makeTurnFinished("requires_approval", TEST_RUNTIME, {
      runId: "run-recovery",
      error: "Recovery continuation ended unexpectedly: requires_approval",
    }),
  );
  await Bun.sleep(0);

  const finished = lifecycleEvents.find((event) => event.type === "finished");
  expect(finished).toMatchObject({
    outcome: "error",
    runId: "run-recovery",
    stopReason: "requires_approval",
    error: "Recovery continuation ended unexpectedly: requires_approval",
  });

  await gateway.submit(makeDelivery({ clientMessageId: "cm-next" }));
  expect(
    lifecycleEvents.filter((event) => event.type === "processing"),
  ).toHaveLength(2);
  gateway.close();
});
