import { expect, test } from "bun:test";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeStreamDelta,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";

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
