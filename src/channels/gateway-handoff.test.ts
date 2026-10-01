import { expect, test } from "bun:test";
import type {
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
  WsProtocolMessage,
} from "@/types/app-server-protocol";
import {
  ChannelGateway,
  type ChannelGatewayHandoffDelivery,
} from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  makeStreamDelta,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";
import type { ChannelTurnSource } from "./types";

function makeHandoff(
  overrides: Partial<ChannelGatewayHandoffDelivery> = {},
): ChannelGatewayHandoffDelivery {
  const delivery = makeDelivery();
  return {
    runtime: delivery.runtime,
    sources: delivery.sources,
    clientMessageId: delivery.clientMessageId,
    ...overrides,
  };
}

class ApprovalReplayClient extends FakeClient {
  override async runtimeStart(
    options: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
  ): Promise<RuntimeStartResponseMessage> {
    this.emit({
      type: "control_request",
      request_id: "control-replayed-during-handoff",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "pwd" },
        tool_call_id: "call-replayed-during-handoff",
        permission_suggestions: [],
        blocked_path: null,
      },
      agent_id: TEST_RUNTIME.agent_id,
      conversation_id: TEST_RUNTIME.conversation_id,
    } as unknown as WsProtocolMessage);
    return await super.runtimeStart(options);
  }
}

class FailFirstStartClient extends FakeClient {
  private shouldFail = true;

  override async runtimeStart(
    options: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
  ): Promise<RuntimeStartResponseMessage> {
    if (this.shouldFail) {
      this.shouldFail = false;
      return {
        type: "runtime_start_response",
        request_id: options.request_id ?? "failed-handoff-start",
        success: false,
        runtime: null,
        agent: null,
        conversation: null,
        created: { agent: false, conversation: false },
        error: "destination unavailable",
      };
    }
    return await super.runtimeStart(options);
  }
}

test("adopts an active delivery without submitting its input again", async () => {
  const client = new FakeClient();
  let executedSources: ChannelTurnSource[] = [];
  const collector = makeHooks({
    executeExternalTool: async (_request, sources) => {
      executedSources = sources;
      return { content: [{ type: "text", text: "sent" }] };
    },
  });
  const gateway = new ChannelGateway(client, collector.hooks);
  const source = makeSource({ channel: "slack", chatId: "C123" });

  await gateway.adoptActiveDelivery(
    makeHandoff({
      sources: [source],
      clientMessageId: "cm-teleported",
    }),
  );

  expect(client.startedRuntimes).toHaveLength(1);
  expect(client.submittedInputs).toHaveLength(0);
  expect(collector.lifecycleEvents).toEqual([
    {
      type: "processing",
      batchId: "channel-cm-teleported",
      sources: [source],
    },
  ]);

  client.emit(
    makeStreamDelta({
      message_type: "reasoning_message",
      run_id: "run-teleported",
    }),
  );
  client.emitExternalToolCall({
    type: "external_tool_call_request",
    request_id: "external-teleported",
    runtime: TEST_RUNTIME,
    tool_call_id: "tool-teleported",
    tool_name: "MessageChannel",
    input: { action: "send", channel: "slack", chat_id: "C123" },
  });
  await Bun.sleep(0);
  expect(collector.progressEvents.length).toBeGreaterThan(0);
  expect(executedSources).toEqual([source]);

  client.emit(
    makeTurnFinished("end_turn", TEST_RUNTIME, {
      runId: "run-teleported",
    }),
  );
  await Bun.sleep(0);
  expect(collector.lifecycleEvents.at(-1)).toEqual({
    type: "finished",
    batchId: "channel-cm-teleported",
    sources: [source],
    outcome: "completed",
    stopReason: "end_turn",
    runId: "run-teleported",
  });
  gateway.close();
});

test("routes approval replay that arrives during destination registration", async () => {
  const client = new ApprovalReplayClient();
  const collector = makeHooks();
  const gateway = new ChannelGateway(client, collector.hooks);
  const source = makeSource({ channel: "slack", chatId: "C-approval" });

  await gateway.adoptActiveDelivery(
    makeHandoff({ sources: [source], clientMessageId: "cm-approval" }),
  );

  expect(collector.controlRequestEvents).toEqual([
    {
      requestId: "control-replayed-during-handoff",
      kind: "generic_tool_approval",
      source,
      toolName: "Bash",
      input: { command: "pwd" },
    },
  ]);
  gateway.close();
});

test("hung processing lifecycle does not block adoption or later delivery", async () => {
  const client = new FakeClient();
  let markProcessingStarted!: () => void;
  const processingStarted = new Promise<void>((resolve) => {
    markProcessingStarted = resolve;
  });
  let releaseProcessing!: () => void;
  const processingGate = new Promise<void>((resolve) => {
    releaseProcessing = resolve;
  });
  const gateway = new ChannelGateway(
    client,
    makeHooks({
      onLifecycle: async (event) => {
        if (event.type !== "processing") return;
        markProcessingStarted();
        await processingGate;
      },
    }).hooks,
  );
  const source = makeSource({ channel: "slack", chatId: "C-hung-hook" });

  const adoption = gateway.adoptActiveDelivery(
    makeHandoff({ sources: [source] }),
  );
  await processingStarted;
  await adoption;
  await expect(
    gateway.submit(
      makeDelivery({
        sources: [source],
        clientMessageId: "cm-after-hung-hook",
      }),
    ),
  ).resolves.toBe(true);
  expect(client.submittedInputs).toHaveLength(1);

  releaseProcessing();
  await Bun.sleep(0);
  gateway.close();
});

test("repeated adoption and original delivery retries stay idempotent", async () => {
  const client = new FakeClient();
  const collector = makeHooks();
  const gateway = new ChannelGateway(client, collector.hooks);
  const source = makeSource({ channel: "slack", chatId: "C-retry" });
  const handoff = makeHandoff({
    sources: [source],
    clientMessageId: "cm-handoff-retry",
  });

  await gateway.adoptActiveDelivery(handoff);
  await gateway.adoptActiveDelivery(handoff);
  expect(
    await gateway.submit(
      makeDelivery({
        sources: [source],
        clientMessageId: "cm-handoff-retry",
      }),
    ),
  ).toBe(true);

  expect(client.startedRuntimes).toHaveLength(1);
  expect(client.submittedInputs).toHaveLength(0);
  expect(
    collector.lifecycleEvents.filter((event) => event.type === "processing"),
  ).toHaveLength(1);
  await expect(
    gateway.adoptActiveDelivery(
      makeHandoff({ clientMessageId: "cm-different-active-turn" }),
    ),
  ).rejects.toThrow("channel-cm-handoff-retry is already active");
  gateway.close();
});

test("releases the matching active delivery without a terminal lifecycle", async () => {
  const client = new FakeClient();
  let draftDisposals = 0;
  const collector = makeHooks({
    createRichDraft: () => ({
      handleDelta: () => undefined,
      flushPending: async () => undefined,
      dispose: () => {
        draftDisposals += 1;
      },
    }),
  });
  const gateway = new ChannelGateway(client, collector.hooks);

  await gateway.adoptActiveDelivery(
    makeHandoff({ clientMessageId: "cm-release" }),
  );
  expect(gateway.releaseActiveDelivery(TEST_RUNTIME, "cm-other")).toBeNull();
  expect(client.runtimeToolUpdates).toHaveLength(0);

  expect(
    gateway.releaseActiveDelivery(TEST_RUNTIME, "cm-release"),
  ).not.toBeNull();
  expect(client.runtimeToolUpdates).toHaveLength(0);
  await gateway.releaseRuntimeTools(TEST_RUNTIME);
  expect(client.runtimeToolUpdates).toEqual([
    { runtimes: [TEST_RUNTIME], external_tools: [] },
  ]);
  expect(gateway.getKnownRuntimes()).toEqual([]);
  expect(draftDisposals).toBe(1);
  expect(
    collector.lifecycleEvents.filter((event) => event.type === "finished"),
  ).toEqual([]);

  client.emit(makeTurnFinished("cancelled"));
  await Bun.sleep(0);
  expect(
    collector.lifecycleEvents.filter((event) => event.type === "finished"),
  ).toEqual([]);
  gateway.close();
});

test("transfers accumulated assistant text across an active handoff", async () => {
  const client = new FakeClient();
  const relays: string[] = [];
  const sourceHooks = makeHooks();
  const destinationHooks = makeHooks({
    relayAssistantText: ({ text }) => {
      relays.push(text);
    },
  });
  const sourceGateway = new ChannelGateway(client, sourceHooks.hooks);
  const destinationGateway = new ChannelGateway(client, destinationHooks.hooks);
  const handoff = makeHandoff({ clientMessageId: "cm-text-handoff" });

  await sourceGateway.adoptActiveDelivery({
    ...handoff,
    activeTurnState: {
      assistantText: {
        currentMessageId: null,
        currentText: "",
        deltaKeys: [],
        finalizedMessageIds: [],
      },
      idempotency: {
        successfulActionKeys: [],
        successfulTextDeliveryKeys: [],
        lastSuccessfulActionKey: null,
      },
    },
  });
  client.emit({
    ...makeStreamDelta({
      message_type: "assistant_message",
      id: "assistant-before",
      otid: "stable-assistant",
      content: "Before",
    }),
    idempotency_key: "assistant-before",
  });
  await Bun.sleep(0);
  const activeTurnState = sourceGateway.releaseActiveDelivery(
    TEST_RUNTIME,
    "cm-text-handoff",
  );
  expect(activeTurnState).not.toBeNull();
  await destinationGateway.adoptActiveDelivery({
    ...handoff,
    activeTurnState: activeTurnState ?? undefined,
  });
  client.emit({
    ...makeStreamDelta({
      message_type: "assistant_message",
      id: "assistant-after",
      otid: "stable-assistant",
      content: " after",
    }),
    idempotency_key: "assistant-after",
  });
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(relays).toEqual(["Before after"]);
  sourceGateway.close();
  destinationGateway.close();
});

test("release waits for queued finalized relay before handing off ownership", async () => {
  const client = new FakeClient();
  const relays: string[] = [];
  let releaseProgress!: () => void;
  const progressBlocked = new Promise<void>((resolve) => {
    releaseProgress = resolve;
  });
  const relayAssistantText = ({ text }: { text: string }) => {
    relays.push(text);
  };
  const sourceGateway = new ChannelGateway(
    client,
    makeHooks({
      onProgress: async () => await progressBlocked,
      relayAssistantText,
    }).hooks,
  );
  const destinationGateway = new ChannelGateway(
    client,
    makeHooks({ relayAssistantText }).hooks,
  );
  const handoff = makeHandoff({ clientMessageId: "cm-queued-relay-handoff" });

  await sourceGateway.adoptActiveDelivery({
    ...handoff,
    activeTurnState: {
      assistantText: {
        currentMessageId: null,
        currentText: "",
        deltaKeys: [],
        finalizedMessageIds: [],
      },
      idempotency: {
        successfulActionKeys: [],
        successfulTextDeliveryKeys: [],
        lastSuccessfulActionKey: null,
      },
    },
  });
  client.emit(
    makeStreamDelta({
      message_type: "reasoning_message",
      id: "reasoning-before-relay",
      content: "working",
    }),
  );
  const finalized = {
    ...makeStreamDelta({
      message_type: "assistant_message",
      id: "assistant-before-handoff",
      content: "Before handoff",
    }),
    idempotency_key: "assistant-before-handoff",
  };
  client.emit(finalized);
  client.emit(
    makeStreamDelta({
      message_type: "tool_call_message",
      id: "tool-before-handoff",
      tool_call: {
        tool_call_id: "tool-call-before-handoff",
        name: "Bash",
        arguments: "{}",
      },
    }),
  );

  expect(
    sourceGateway.releaseActiveDelivery(
      TEST_RUNTIME,
      "cm-queued-relay-handoff",
    ),
  ).toBeNull();
  expect(relays).toEqual([]);

  releaseProgress();
  await Bun.sleep(0);
  expect(relays).toEqual(["Before handoff"]);
  const activeTurnState = sourceGateway.releaseActiveDelivery(
    TEST_RUNTIME,
    "cm-queued-relay-handoff",
  );
  expect(activeTurnState).not.toBeNull();

  await destinationGateway.adoptActiveDelivery({
    ...handoff,
    activeTurnState: activeTurnState ?? undefined,
  });
  client.emit(finalized);
  client.emit(
    makeStreamDelta({
      message_type: "assistant_message",
      id: "assistant-after-handoff",
      content: "After handoff",
    }),
  );
  client.emit(
    makeStreamDelta({ message_type: "stop_reason", stop_reason: "end_turn" }),
  );
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(relays).toEqual(["Before handoff", "After handoff"]);
  sourceGateway.close();
  destinationGateway.close();
});

test("handoff preserves finalized identities and does not resend replayed text", async () => {
  const client = new FakeClient();
  const relays: string[] = [];
  const relayAssistantText = ({ text }: { text: string }) => {
    relays.push(text);
  };
  const sourceGateway = new ChannelGateway(
    client,
    makeHooks({ relayAssistantText }).hooks,
  );
  const destinationGateway = new ChannelGateway(
    client,
    makeHooks({ relayAssistantText }).hooks,
  );
  const handoff = makeHandoff({ clientMessageId: "cm-finalized-handoff" });

  await sourceGateway.adoptActiveDelivery({
    ...handoff,
    activeTurnState: {
      assistantText: {
        currentMessageId: null,
        currentText: "",
        deltaKeys: [],
        finalizedMessageIds: [],
      },
      idempotency: {
        successfulActionKeys: [],
        successfulTextDeliveryKeys: [],
        lastSuccessfulActionKey: null,
      },
    },
  });
  const first = {
    ...makeStreamDelta({
      message_type: "assistant_message",
      id: "assistant-finalized",
      content: "Already sent",
    }),
    idempotency_key: "assistant-finalized",
  };
  client.emit(first);
  client.emit(
    makeStreamDelta({
      message_type: "tool_call_message",
      id: "tool-boundary",
      tool_call: {
        tool_call_id: "tool-call-boundary",
        name: "Bash",
        arguments: "{}",
      },
    }),
  );
  await Bun.sleep(0);
  expect(relays).toEqual(["Already sent"]);

  const activeTurnState = sourceGateway.releaseActiveDelivery(
    TEST_RUNTIME,
    "cm-finalized-handoff",
  );
  expect(activeTurnState).not.toBeNull();
  await destinationGateway.adoptActiveDelivery({
    ...handoff,
    activeTurnState: activeTurnState ?? undefined,
  });
  client.emit(first);
  client.emit(
    makeStreamDelta({ message_type: "stop_reason", stop_reason: "end_turn" }),
  );
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(relays).toEqual(["Already sent"]);
  sourceGateway.close();
  destinationGateway.close();
});

test("failed destination registration leaves no adopted or deduped state", async () => {
  const client = new FailFirstStartClient();
  const collector = makeHooks();
  const gateway = new ChannelGateway(client, collector.hooks);

  await expect(
    gateway.adoptActiveDelivery(
      makeHandoff({ clientMessageId: "cm-failed-adoption" }),
    ),
  ).rejects.toThrow("destination unavailable");
  expect(gateway.getKnownRuntimes()).toEqual([]);
  expect(collector.lifecycleEvents).toEqual([]);

  expect(
    await gateway.submit(
      makeDelivery({ clientMessageId: "cm-failed-adoption" }),
    ),
  ).toBe(true);
  expect(client.submittedInputs).toHaveLength(1);
  gateway.close();
});
