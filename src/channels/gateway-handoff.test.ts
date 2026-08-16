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

test("adoption waits for processing ownership to be recorded", async () => {
  const client = new FakeClient();
  let releaseProcessing: (() => void) | undefined;
  let processingRecorded = false;
  const gateway = new ChannelGateway(
    client,
    makeHooks({
      onLifecycle: async () => {
        await new Promise<void>((resolve) => {
          releaseProcessing = resolve;
        });
        processingRecorded = true;
      },
    }).hooks,
  );

  const adoption = gateway.adoptActiveDelivery(makeHandoff());
  await Bun.sleep(0);
  expect(processingRecorded).toBe(false);
  releaseProcessing?.();
  await adoption;
  expect(processingRecorded).toBe(true);
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
  expect(gateway.releaseActiveDelivery(TEST_RUNTIME, "cm-other")).toBe(false);
  expect(client.runtimeToolUpdates).toHaveLength(0);

  expect(gateway.releaseActiveDelivery(TEST_RUNTIME, "cm-release")).toBe(true);
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
