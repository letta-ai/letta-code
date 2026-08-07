import { expect, test } from "bun:test";
import type {
  ApprovalResponseBody,
  ExternalToolCallRequestMessage,
  RuntimeStartResponseMessage,
  WsProtocolMessage,
} from "@/types/app-server-protocol";
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
import type { ChannelTurnSource } from "./types";

// ── Tests ────────────────────────────────────────────────────────

test("direct started input activates sources immediately", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  const source = makeSource({ channel: "telegram", chatId: "chat-1" });
  await gateway.submit(
    makeDelivery({ sources: [source], clientMessageId: "cm-1" }),
  );

  // Should emit queued lifecycle for each source
  expect(lifecycleEvents.filter((e) => e.type === "queued")).toHaveLength(1);
  // Should emit processing lifecycle
  expect(lifecycleEvents.filter((e) => e.type === "processing")).toHaveLength(
    1,
  );
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "queued",
    "processing",
  ]);
  const processingEvent = lifecycleEvents.find((e) => e.type === "processing");
  expect(processingEvent).toBeDefined();
  if (processingEvent && processingEvent.type === "processing") {
    expect(processingEvent.sources).toEqual([source]);
    expect(processingEvent.batchId).toBe("channel-cm-1");
  }

  gateway.close();
});

test("serializes progress and terminal hooks behind asynchronous processing", async () => {
  const client = new FakeClient();
  const order: string[] = [];
  let releaseProcessing!: () => void;
  const processingGate = new Promise<void>((resolve) => {
    releaseProcessing = resolve;
  });
  const { hooks } = makeHooks({
    onLifecycle: async (event) => {
      if (event.type !== "processing") {
        order.push(event.type);
        return;
      }
      order.push("processing:start");
      await processingGate;
      order.push("processing:end");
    },
    onProgress: () => {
      order.push("progress");
    },
  });
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-ordered" }));
  client.emit(
    makeStreamDelta({
      message_type: "reasoning_message",
      run_id: "run-ordered",
    }),
  );
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(order).toEqual(["queued", "processing:start"]);
  releaseProcessing();
  await Bun.sleep(0);
  expect(order).toEqual([
    "queued",
    "processing:start",
    "processing:end",
    "progress",
    "finished",
  ]);

  gateway.close();
});

test("queued input activates when dequeued via update_queue", async () => {
  const client = new FakeClient({
    inputResponse: { accepted: true, disposition: "queued" },
  });
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  const source = makeSource({ channel: "telegram", chatId: "chat-1" });
  await gateway.submit(
    makeDelivery({ sources: [source], clientMessageId: "cm-queued-1" }),
  );

  // Should have queued but not processing yet
  expect(lifecycleEvents.filter((e) => e.type === "queued")).toHaveLength(1);
  expect(lifecycleEvents.filter((e) => e.type === "processing")).toHaveLength(
    0,
  );

  // Simulate dequeue: queue update where the item is no longer in the queue
  client.emit(makeQueueUpdate([]) as unknown as WsProtocolMessage);

  // Now processing should be activated
  expect(lifecycleEvents.filter((e) => e.type === "processing")).toHaveLength(
    1,
  );
  const processingEvent = lifecycleEvents.find((e) => e.type === "processing");
  if (processingEvent && processingEvent.type === "processing") {
    expect(processingEvent.sources).toEqual([source]);
  }

  gateway.close();
});

test("source steering does not merge sources from a new turn into an active turn", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  const source1 = makeSource({ channel: "telegram", chatId: "chat-1" });
  const source2 = makeSource({ channel: "slack", chatId: "chat-2" });

  // First turn starts immediately (default disposition is "started")
  await gateway.submit(
    makeDelivery({ sources: [source1], clientMessageId: "cm-a" }),
  );

  // Switch to "queued" so the second turn is queued while first is active
  client.inputResponse.disposition = "queued";
  await gateway.submit(
    makeDelivery({ sources: [source2], clientMessageId: "cm-b" }),
  );

  // The active turn should still only have source1
  const processingEvents = lifecycleEvents.filter(
    (e) => e.type === "processing",
  );
  expect(processingEvents).toHaveLength(1);
  const firstProcessing = processingEvents[0];
  if (firstProcessing && firstProcessing.type === "processing") {
    expect(firstProcessing.sources).toEqual([source1]);
  }

  // Finish the first turn
  client.emit(makeTurnFinished("end_turn"));

  // Dequeue the second turn
  client.emit(makeQueueUpdate([]) as unknown as WsProtocolMessage);
  await Bun.sleep(0);

  // Now the second turn should be processing with only source2 (not merged)
  const allProcessing = lifecycleEvents.filter((e) => e.type === "processing");
  expect(allProcessing).toHaveLength(2);
  const secondProcessing = allProcessing[1];
  if (secondProcessing && secondProcessing.type === "processing") {
    expect(secondProcessing.sources).toEqual([source2]);
    expect(secondProcessing.sources).not.toContain(source1);
  }

  gateway.close();
});

test("terminal turn_finished with end_turn emits finished with completed outcome", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-end" }));

  client.emit(makeTurnFinished("end_turn"));

  const finishedEvents = lifecycleEvents.filter((e) => e.type === "finished");
  expect(finishedEvents).toHaveLength(1);
  const finished = finishedEvents[0];
  if (finished && finished.type === "finished") {
    expect(finished.outcome).toBe("completed");
    expect(finished.stopReason).toBe("end_turn");
  }

  gateway.close();
});

test("terminal turn_finished with cancelled emits finished with cancelled outcome", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-cancel" }));

  client.emit(makeTurnFinished("cancelled"));

  const finishedEvents = lifecycleEvents.filter((e) => e.type === "finished");
  expect(finishedEvents).toHaveLength(1);
  const finished = finishedEvents[0];
  if (finished && finished.type === "finished") {
    expect(finished.outcome).toBe("cancelled");
    expect(finished.stopReason).toBe("cancelled");
  }

  gateway.close();
});

test("terminal turn_finished with error emits finished with error outcome and error message", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-err" }));

  client.emit(makeTurnFinished("error", TEST_RUNTIME, { error: "API failed" }));

  const finishedEvents = lifecycleEvents.filter((e) => e.type === "finished");
  expect(finishedEvents).toHaveLength(1);
  const finished = finishedEvents[0];
  if (finished && finished.type === "finished") {
    expect(finished.outcome).toBe("error");
    expect(finished.stopReason).toBe("error");
    expect(finished.error).toBe("API failed");
  }

  gateway.close();
});

test("MessageChannel external tool execution routes to hooks.executeExternalTool", async () => {
  const client = new FakeClient();
  const collector = makeHooks();
  const gateway = new ChannelGateway(client, collector.hooks);

  const source = makeSource({ channel: "telegram", chatId: "chat-1" });
  await gateway.submit(makeDelivery({ sources: [source] }));

  // Simulate external tool call request from the server
  const toolRequest: ExternalToolCallRequestMessage = {
    type: "external_tool_call_request",
    request_id: "ext-1",
    runtime: TEST_RUNTIME,
    tool_call_id: "call-1",
    tool_name: "MessageChannel",
    input: { channel: "telegram", action: "send", text: "Hi" },
  };

  client.emitExternalToolCall(toolRequest);

  // Wait for async handler to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(collector.externalToolResults).toHaveLength(1);
  expect(collector.externalToolResults[0]?.content[0]?.text).toBe("ok");

  gateway.close();
});

test("process-owned turns execute MessageChannel with the runtime's routed sources", async () => {
  const client = new FakeClient();
  let executedSources: ChannelTurnSource[] = [];
  const { hooks } = makeHooks({
    executeExternalTool: async (_request, sources) => {
      executedSources = sources;
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const gateway = new ChannelGateway(client, hooks);
  const source = makeSource({ channel: "slack", chatId: "C123" });

  await gateway.registerRuntime(TEST_RUNTIME, [source]);
  client.emitExternalToolCall({
    type: "external_tool_call_request",
    request_id: "ext-cron",
    runtime: TEST_RUNTIME,
    tool_call_id: "call-cron",
    tool_name: "MessageChannel",
    input: { channel: "slack", action: "send", chat_id: "C123" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(executedSources).toEqual([source]);
  gateway.close();
});

test("approval response is forwarded via submitApprovalResponse", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  const approval: ApprovalResponseBody = {
    request_id: "approval-1",
    decision: { behavior: "allow" },
  };

  const accepted = await gateway.submitApprovalResponse(TEST_RUNTIME, approval);
  expect(accepted).toBe(true);

  // Verify the input was submitted with approval_response payload
  expect(client.submittedInputs).toHaveLength(1);
  const submitted = client.submittedInputs[0];
  expect(submitted?.payload).toMatchObject({
    kind: "approval_response",
    request_id: "approval-1",
  });

  gateway.close();
});

test("stale approval recovery does not retain an active turn", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);
  const staleSource = makeSource({ chatId: "stale-chat" });
  const nextSource = makeSource({ chatId: "next-chat" });

  expect(await gateway.restoreRuntime(TEST_RUNTIME, [staleSource])).toEqual(
    new Set(),
  );
  await gateway.submit(
    makeDelivery({ sources: [nextSource], clientMessageId: "cm-after-stale" }),
  );

  const processing = lifecycleEvents.find(
    (event) => event.type === "processing",
  );
  expect(processing).toBeDefined();
  if (processing?.type === "processing") {
    expect(processing.sources).toEqual([nextSource]);
  }

  gateway.close();
});

test("runtime registration happens before input submission", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-reg-1" }));

  // runtimeStart should have been called before submitInput
  expect(client.startedRuntimes).toHaveLength(1);
  expect(client.submittedInputs).toHaveLength(1);

  // The runtime start should include the external tool registration
  const startOpts = client.startedRuntimes[0];
  expect(startOpts?.agent_id).toBe("agent-1");
  expect(startOpts?.conversation_id).toBe("conv-1");
  expect(startOpts?.conversation_source_tags).toEqual(["channel:telegram"]);
  expect(startOpts?.preserve_skill_sources).toBe(true);
  expect(startOpts?.external_tools).toEqual([
    {
      tools: [
        {
          name: "MessageChannel",
          description: "Send a message through a channel",
          parameters: {},
        },
      ],
    },
  ]);

  gateway.close();
});

test("runtime registration follows routed channel sources", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.registerRuntime(TEST_RUNTIME, [
    makeSource({ channel: "telegram", chatId: "chat-1" }),
    makeSource({ channel: "telegram", chatId: "chat-2" }),
  ]);
  await gateway.registerRuntime(TEST_RUNTIME, [
    makeSource({ channel: "slack", chatId: "C123" }),
  ]);

  expect(client.startedRuntimes).toHaveLength(2);
  expect(client.startedRuntimes[0]?.conversation_source_tags).toEqual([
    "channel:telegram",
  ]);
  expect(client.startedRuntimes[1]?.conversation_source_tags).toEqual([
    "channel:slack",
  ]);

  gateway.close();
});

test("serializes routed tool publication with runtime registration", async () => {
  let releaseToolUpdate!: () => void;
  const toolUpdateWait = new Promise<void>((resolve) => {
    releaseToolUpdate = resolve;
  });
  const client = new FakeClient({ toolUpdateWait });
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);
  const source = makeSource();

  const publication = gateway.updateRoutedRuntimeTools(
    [
      {
        runtimes: [TEST_RUNTIME],
        external_tools: [
          {
            tools: [
              {
                name: "MessageChannel",
                description: "Send a message through a channel",
                parameters: {},
              },
            ],
          },
        ],
      },
    ],
    [{ runtime: TEST_RUNTIME, sources: [source] }],
  );
  const registration = gateway.registerRuntime(TEST_RUNTIME, [source]);

  await Bun.sleep(0);
  expect(client.runtimeToolUpdates).toHaveLength(1);
  expect(client.startedRuntimes).toHaveLength(0);

  releaseToolUpdate();
  await Promise.all([publication, registration]);
  expect(client.startedRuntimes).toHaveLength(1);
  gateway.close();
});

test("publishes hundreds of routed runtime tools without runtime_start", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);
  const runtimes = Array.from({ length: 350 }, (_, index) => ({
    agent_id: "agent-1",
    conversation_id: `conv-${index}`,
  }));

  await gateway.updateRoutedRuntimeTools(
    [
      {
        runtimes,
        external_tools: [
          {
            tools: [
              {
                name: "MessageChannel",
                description: "Send a message through a channel",
                parameters: {},
              },
            ],
          },
        ],
      },
    ],
    runtimes.map((runtime) => ({
      runtime,
      sources: [
        makeSource({
          agentId: runtime.agent_id,
          conversationId: runtime.conversation_id,
        }),
      ],
    })),
  );

  expect(client.runtimeToolUpdates[0]?.runtimes).toHaveLength(350);
  expect(client.startedRuntimes).toHaveLength(0);
  gateway.close();
});

test("runtime registration removes MessageChannel when no route remains", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks({ buildExternalTool: async () => null });
  const gateway = new ChannelGateway(client, hooks);

  await gateway.registerRuntime(TEST_RUNTIME, []);

  expect(client.startedRuntimes[0]?.external_tools).toEqual([]);

  gateway.close();
});

test("runtime registration is skipped when signature matches", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  // First submit triggers registration
  await gateway.submit(makeDelivery({ clientMessageId: "cm-1" }));
  expect(client.startedRuntimes).toHaveLength(1);

  // Second submit with same delivery params should not re-register
  await gateway.submit(makeDelivery({ clientMessageId: "cm-2" }));
  expect(client.startedRuntimes).toHaveLength(1);

  gateway.close();
});

test("retries with the same client message ID are idempotent", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);
  const delivery = makeDelivery({ clientMessageId: "cm-stable-retry" });

  await expect(gateway.submit(delivery)).resolves.toBe(true);
  await expect(gateway.submit(delivery)).resolves.toBe(true);

  expect(client.submittedInputs).toHaveLength(1);
  expect(
    lifecycleEvents.filter((event) => event.type === "queued"),
  ).toHaveLength(1);
  gateway.close();
});

test("runtime registration exposes and updates model status without backend access", async () => {
  const client = new FakeClient({
    startResponse: {
      agent: {
        id: "agent-1",
        llm_config: { model: "anthropic/claude-sonnet-4-6" },
      } as RuntimeStartResponseMessage["agent"],
    },
  });
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery());
  expect(gateway.getModelStatus(TEST_RUNTIME)).toEqual({
    modelHandle: "anthropic/claude-sonnet-4-6",
    scope: "conversation",
  });

  gateway.updateModelStatus(TEST_RUNTIME, "openai/gpt-5");
  expect(gateway.getModelStatus(TEST_RUNTIME)).toEqual({
    modelHandle: "openai/gpt-5",
    scope: "conversation",
  });
  gateway.close();
});

test("control request with single source dispatches to onControlRequest", async () => {
  const client = new FakeClient();
  const { hooks, controlRequestEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  const source = makeSource({ channel: "telegram", chatId: "chat-1" });
  await gateway.submit(makeDelivery({ sources: [source] }));

  // Simulate a control request (approval) from the server
  client.emit({
    type: "control_request",
    request_id: "ctrl-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_call_id: "call-1",
      permission_suggestions: [],
      blocked_path: null,
    },
    agent_id: "agent-1",
    conversation_id: "conv-1",
  } as unknown as WsProtocolMessage);

  expect(controlRequestEvents).toHaveLength(1);
  const event = controlRequestEvents[0];
  expect(event).toBeDefined();
  expect(event?.requestId).toBe("ctrl-1");
  expect(event?.toolName).toBe("Bash");
  expect(event?.source).toEqual(source);

  gateway.close();
});

test("control request with multiple sources does not dispatch", async () => {
  const client = new FakeClient();
  const { hooks, controlRequestEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  const source1 = makeSource({ channel: "telegram", chatId: "chat-1" });
  const source2 = makeSource({ channel: "slack", chatId: "chat-2" });
  await gateway.submit(
    makeDelivery({ sources: [source1, source2], clientMessageId: "cm-multi" }),
  );

  client.emit({
    type: "control_request",
    request_id: "ctrl-2",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_call_id: "call-2",
      permission_suggestions: [],
      blocked_path: null,
    },
    agent_id: "agent-1",
    conversation_id: "conv-1",
  } as unknown as WsProtocolMessage);

  expect(controlRequestEvents).toHaveLength(0);

  gateway.close();
});

test("close disposes all listeners and clears state", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-close" }));

  gateway.close();

  // After close, emitting messages should not trigger any hooks
  // (listeners are disposed)
  client.emit(makeTurnFinished("end_turn"));

  // client.close() should have been called
  expect(client.closeCalls).toBe(1);
});
