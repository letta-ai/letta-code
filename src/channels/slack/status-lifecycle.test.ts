import { expect, test } from "bun:test";
import {
  ChannelGateway,
  type ChannelGatewayDelivery,
} from "@/channels/gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeQueueUpdate,
  makeStreamDelta,
  makeTurnFinished,
  TEST_RUNTIME,
} from "@/channels/gateway-test-support";
import {
  createSlackTurnSource,
  createStartedSlackAdapter,
  getSlackWriteClient,
  installSlackAdapterTestHooks,
} from "./adapter-test-harness";

installSlackAdapterTestHooks();

async function setup() {
  const adapter = await createStartedSlackAdapter();
  const client = new FakeClient();
  const { hooks } = makeHooks({
    onLifecycle: (event) => adapter.handleTurnLifecycleEvent?.(event),
    onProgress: (event) => adapter.handleTurnProgressEvent?.(event),
  });
  const gateway = new ChannelGateway(client, hooks);
  const source = createSlackTurnSource();
  const delivery = makeDelivery({
    sources: [source],
    clientMessageId: "first",
  });
  const submit = async (options: Partial<ChannelGatewayDelivery> = {}) => {
    await gateway.submit({ ...delivery, ...options });
    await Bun.sleep(0);
  };
  const tool = async (name = "Bash") => {
    client.emit(
      makeStreamDelta({
        message_type: "tool_call_message",
        id: `message-${name}`,
        tool_calls: [
          {
            name,
            tool_call_id: `call-${name}`,
            arguments: JSON.stringify({
              command: "pwd",
              description: "Inspect the workspace",
            }),
          },
        ],
      }),
    );
    await Bun.sleep(0);
  };
  const statuses = () =>
    getSlackWriteClient().assistant.threads.setStatus.mock.calls.map(
      ([args]) => args.status,
    );
  const followup = () => ({
    ...delivery,
    clientMessageId: "followup",
    sources: [{ ...source, messageId: "1712800000.000300" }],
  });
  return { adapter, client, gateway, source, submit, tool, statuses, followup };
}

test("cold existing thread continues the host's waking status through reasoning and MessageChannel", async () => {
  const h = await setup();
  // The external host already wrote waking before it could reach the gateway.
  const slack = getSlackWriteClient();
  await slack.assistant.threads.setStatus({
    channel_id: h.source.chatId,
    thread_ts: h.source.threadId,
    status: "is waking up...",
    loading_messages: ["is waking up..."],
  });
  await h.submit({ sources: [{ ...h.source, showStartupStatus: true }] });
  h.client.emit(
    makeStreamDelta({
      message_type: "reasoning_message",
      reasoning: "Reply directly",
    }),
  );
  await h.tool("MessageChannel");
  expect(h.statuses()).toEqual(["is waking up...", "is thinking..."]);
  await h.adapter.sendMessage({
    channel: "slack",
    chatId: h.source.chatId,
    threadId: h.source.threadId,
    agentId: h.source.agentId,
    conversationId: h.source.conversationId,
    text: "Hello",
  });
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("");
  expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  h.gateway.close();
});

test("warm existing thread stays quiet through reasoning and MessageChannel", async () => {
  const h = await setup();
  await h.submit();
  h.client.emit(
    makeStreamDelta({
      message_type: "reasoning_message",
      reasoning: "Nothing to do",
    }),
  );
  await h.tool("MessageChannel");
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  expect(h.statuses().every((status) => status === "")).toBe(true);
  h.gateway.close();
});

test("steering reasserts the current tool title even when it has not changed", async () => {
  const h = await setup();
  await h.submit();
  await h.tool();
  const slack = getSlackWriteClient();
  const last = slack.assistant.threads.setStatus.mock.calls.at(-1)?.[0];
  expect(last?.status).toBe("is working...");
  const count = h.statuses().length;
  h.client.inputResponse.disposition = "queued";
  await h.submit(h.followup());
  expect(h.statuses().length).toBe(count + 1);
  expect(slack.assistant.threads.setStatus.mock.calls.at(-1)?.[0]).toEqual(
    last,
  );
  h.client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "followup", disposition: "dequeued" },
    ]),
  );
  await Bun.sleep(0);
  expect(h.statuses().slice(count)).not.toContain("");
  h.gateway.close();
});

test("already-visible work continues across a turn boundary into queued input", async () => {
  const h = await setup();
  await h.submit();
  await h.tool();
  h.client.inputResponse.disposition = "queued";
  await h.submit(h.followup());
  const count = h.statuses().length;
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  h.client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "followup", disposition: "dequeued" },
    ]),
  );
  await Bun.sleep(0);
  expect(h.statuses().slice(count)).not.toContain("");
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("");
  h.gateway.close();
});

test("cancelling queued input does not clear the tool still running", async () => {
  const h = await setup();
  await h.submit();
  await h.tool();
  h.client.inputResponse.disposition = "queued";
  await h.submit(h.followup());
  const count = h.statuses().length;
  h.client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "followup", disposition: "cancelled" },
    ]),
  );
  await Bun.sleep(0);
  expect(h.statuses().slice(count)).not.toContain("");
  h.client.emit(makeTurnFinished("cancelled"));
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("");
  h.gateway.close();
});

for (const failure of ["rejected", "throw"] as const) {
  test(`steering ${failure} after the active turn ends clears carried activity`, async () => {
    const h = await setup();
    await h.submit();
    await h.tool();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const submitInput = h.client.submitInput.bind(h.client);
    h.client.submitInput = async (command) => {
      entered.resolve();
      await release.promise;
      if (failure === "throw") throw new Error("Transport closed");
      h.client.inputResponse.accepted = false;
      return submitInput(command);
    };
    const pending = h.gateway.submit(h.followup()).then(
      (accepted) => accepted,
      () => false,
    );
    await entered.promise;
    const count = h.statuses().length;
    h.client.emit(makeTurnFinished("end_turn"));
    await Bun.sleep(0);
    expect(h.statuses().slice(count)).not.toContain("");
    release.resolve();
    expect(await pending).toBe(false);
    await Bun.sleep(0);
    expect(h.statuses().at(-1)).toBe("");
    h.gateway.close();
  });
}

test("a reply closes the visibility gate even with another input queued", async () => {
  const h = await setup();
  await h.submit();
  await h.tool();
  await h.adapter.sendMessage({
    channel: "slack",
    chatId: h.source.chatId,
    threadId: h.source.threadId,
    agentId: h.source.agentId,
    conversationId: h.source.conversationId,
    text: "Done with that part",
  });
  const count = h.statuses().length;
  h.client.inputResponse.disposition = "queued";
  await h.submit(h.followup());
  h.client.emit(makeTurnFinished("end_turn"));
  h.client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "followup", disposition: "dequeued" },
    ]),
  );
  await h.tool("MessageChannel");
  expect(
    h
      .statuses()
      .slice(count)
      .every((status) => status === ""),
  ).toBe(true);
  h.gateway.close();
});

test("cancelling the last queued input after a completed turn clears carried activity", async () => {
  const h = await setup();
  await h.submit();
  await h.tool();
  h.client.inputResponse.disposition = "queued";
  await h.submit(h.followup());
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("is working...");
  h.client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "followup", disposition: "cancelled" },
    ]),
  );
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("");
  h.gateway.close();
});

for (const stopReason of ["cancelled", "error", "tool_rule", "end_turn"]) {
  test(`${stopReason} clears activity when no input remains`, async () => {
    const h = await setup();
    await h.submit();
    await h.tool();
    h.client.emit(makeTurnFinished(stopReason));
    await Bun.sleep(0);
    expect(h.statuses().at(-1)).toBe("");
    const count = h.statuses().length;
    await h.submit({ ...h.followup(), clientMessageId: "later" });
    expect(
      h
        .statuses()
        .slice(count)
        .every((status) => status === ""),
    ).toBe(true);
    h.gateway.close();
  });
}

test("approval continuation retains activity until a reply or terminal event", async () => {
  const h = await setup();
  await h.submit();
  await h.tool();
  const count = h.statuses().length;
  h.client.emit(
    makeStreamDelta({
      message_type: "stop_reason",
      stop_reason: "requires_approval",
    }),
  );
  await Bun.sleep(0);
  expect(h.statuses().slice(count)).not.toContain("");
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("");
  h.gateway.close();
});

test("retrying accepted cold input does not restart thinking after a reply", async () => {
  const h = await setup();
  const cold = { sources: [{ ...h.source, showStartupStatus: true }] };
  await h.submit(cold);
  await h.adapter.sendMessage({
    channel: "slack",
    chatId: h.source.chatId,
    threadId: h.source.threadId,
    agentId: h.source.agentId,
    conversationId: h.source.conversationId,
    text: "Hello",
  });
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  const count = h.statuses().length;
  await h.submit(cold);
  expect(h.statuses()).toHaveLength(count);
  h.gateway.close();
});

test("rejected input between turns clears status when the previously queued input was cancelled", async () => {
  const h = await setup();
  await h.submit();
  await h.tool();
  h.client.inputResponse.disposition = "queued";
  await h.submit(h.followup());
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const submitInput = h.client.submitInput.bind(h.client);
  h.client.submitInput = async (command) => {
    entered.resolve();
    await release.promise;
    h.client.inputResponse.accepted = false;
    return submitInput(command);
  };
  const last = h.gateway.submit({ ...h.followup(), clientMessageId: "third" });
  await entered.promise;
  h.client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "followup", disposition: "cancelled" },
    ]),
  );
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("is working...");
  release.resolve();
  expect(await last).toBe(false);
  await Bun.sleep(0);
  expect(h.statuses().at(-1)).toBe("");
  h.gateway.close();
});
