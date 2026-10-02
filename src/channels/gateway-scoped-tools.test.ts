import { expect, test } from "bun:test";
import type { ExternalToolCallRequestMessage } from "@/types/app-server-protocol";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeQueueUpdate,
  makeSource,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";
import type { ChannelTurnSource } from "./types";

function inputScope(client: FakeClient, index: number): string | undefined {
  const payload = client.submittedInputs[index]?.payload as
    | { external_tool_scope_ids?: string[] }
    | undefined;
  return payload?.external_tool_scope_ids?.[0];
}

function toolRequest(scopeId: string): ExternalToolCallRequestMessage {
  return {
    type: "external_tool_call_request",
    request_id: `request-${scopeId}`,
    runtime: TEST_RUNTIME,
    scope_id: scopeId,
    tool_call_id: `call-${scopeId}`,
    tool_name: "MessageChannel",
    input: { action: "send" },
  };
}

test("relay deliveries receive distinct non-tool sentinel selectors", async () => {
  const client = new FakeClient();
  const { hooks } = makeHooks({
    resolveAssistantRelayPolicy: () => true,
    buildExternalTool: async () => null,
  });
  const gateway = new ChannelGateway(client, hooks);
  await gateway.submit(
    makeDelivery({ clientMessageId: "cm-relay-a", sources: [makeSource()] }),
  );
  client.inputResponse.disposition = "queued";
  await gateway.submit(
    makeDelivery({
      clientMessageId: "cm-relay-b",
      sources: [makeSource({ channel: "slack", chatId: "C-relay-b" })],
    }),
  );

  expect(inputScope(client, 0)).toMatch(/^channel-turn-/);
  expect(inputScope(client, 1)).toMatch(/^channel-turn-/);
  expect(inputScope(client, 0)).not.toBe(inputScope(client, 1));
  expect(client.startedRuntimes).toHaveLength(2);
  expect(
    client.startedRuntimes.every(
      (start) =>
        Array.isArray(start.external_tools) &&
        start.external_tools.length === 0,
    ),
  ).toBe(true);
  gateway.close();
});

test("retained scopes clone a cached host tool descriptor", async () => {
  const client = new FakeClient();
  const cachedTool = {
    name: "MessageChannel",
    description: "original descriptor",
    parameters: {
      type: "object",
      properties: { channel: { type: "string", enum: ["slack"] } },
    },
  };
  const gateway = new ChannelGateway(
    client,
    makeHooks({ buildExternalTool: async () => cachedTool }).hooks,
  );
  await gateway.submit(
    makeDelivery({
      clientMessageId: "cm-cached-a",
      sources: [makeSource({ channel: "slack", chatId: "C-cached-a" })],
    }),
  );
  const firstScope = inputScope(client, 0);
  cachedTool.description = "mutated descriptor";
  cachedTool.parameters.properties.channel.enum[0] = "telegram";
  client.inputResponse.disposition = "queued";
  await gateway.submit(
    makeDelivery({
      clientMessageId: "cm-cached-b",
      sources: [makeSource({ channel: "telegram", chatId: "T-cached-b" })],
    }),
  );

  const groups = client.startedRuntimes[1]?.external_tools as Array<{
    scope_id: string;
    tools: Array<typeof cachedTool>;
  }>;
  expect(
    groups.find((group) => group.scope_id === firstScope)?.tools[0],
  ).toEqual({
    name: "MessageChannel",
    description: "original descriptor",
    parameters: {
      type: "object",
      properties: { channel: { type: "string", enum: ["slack"] } },
    },
  });
  gateway.close();
});

test("scoped callbacks retain immutable delivery sources and stale scopes fail closed", async () => {
  const client = new FakeClient();
  client.inputResponse.disposition = "started";
  const calls: ChannelTurnSource[][] = [];
  const gateway = new ChannelGateway(
    client,
    makeHooks({
      executeExternalTool: async (_request, sources) => {
        calls.push(sources);
        return { content: [{ type: "text", text: "ok" }] };
      },
    }).hooks,
  );
  const slack = makeSource({ channel: "slack", chatId: "C-slack" });
  const telegram = makeSource({ channel: "telegram", chatId: "T-telegram" });

  await gateway.submit(
    makeDelivery({ sources: [slack], clientMessageId: "cm-slack" }),
  );
  client.inputResponse.disposition = "queued";
  await gateway.submit(
    makeDelivery({ sources: [telegram], clientMessageId: "cm-telegram" }),
  );
  const slackScope = inputScope(client, 0);
  const telegramScope = inputScope(client, 1);
  expect(slackScope).toBeString();
  expect(telegramScope).toBeString();
  if (!slackScope || !telegramScope) throw new Error("missing tool scope");

  await client.requestExternalToolCall(toolRequest(slackScope));
  await client.requestExternalToolCall(toolRequest(telegramScope));
  expect(calls).toEqual([[slack], [telegram]]);
  await expect(
    client.requestExternalToolCall(toolRequest("scope-unknown")),
  ).rejects.toThrow("Unknown or stale external tool scope");

  client.emit(makeTurnFinished("end_turn"));
  client.emit(
    makeQueueUpdate([], TEST_RUNTIME, [
      { client_message_id: "cm-telegram", disposition: "dequeued" },
    ]),
  );
  await expect(
    client.requestExternalToolCall(toolRequest(slackScope)),
  ).rejects.toThrow("Unknown or stale external tool scope");
  await expect(
    client.requestExternalToolCall(toolRequest(telegramScope)),
  ).resolves.toMatchObject({ content: [{ text: "ok" }] });
  gateway.close();
});

test("relay sentinel selectors see no proactive tool while routed work is retained", async () => {
  const client = new FakeClient();
  let relay = false;
  const { hooks } = makeHooks({
    resolveAssistantRelayPolicy: () => relay,
    buildExternalTool: async (_runtime, _sources, policy) =>
      policy?.automaticRelay
        ? null
        : { name: "MessageChannel", description: "scoped", parameters: {} },
  });
  const gateway = new ChannelGateway(client, hooks);
  const source = makeSource();

  await gateway.updateRoutedRuntimeTools(
    [
      {
        runtimes: [TEST_RUNTIME],
        external_tools: [
          {
            tools: [
              {
                name: "MessageChannel",
                description: "proactive",
                parameters: {},
              },
            ],
          },
        ],
      },
    ],
    [{ runtime: TEST_RUNTIME, sources: [source] }],
  );
  relay = true;
  await gateway.submit(makeDelivery({ sources: [source] }));

  expect(inputScope(client, 0)).toMatch(/^channel-turn-/);
  expect(client.startedRuntimes.at(-1)?.external_tools).toEqual([]);
  client.emit(makeTurnFinished("cancelled"));
  await Bun.sleep(0);
  expect(client.runtimeToolUpdates.at(-1)?.external_tools).toMatchObject([
    { tools: [{ description: "proactive" }] },
  ]);
  gateway.close();
});

test("reverse relay-to-tool mode changes apply only to the next input scope", async () => {
  const client = new FakeClient();
  let relay = true;
  const { hooks } = makeHooks({
    resolveAssistantRelayPolicy: () => relay,
    buildExternalTool: async (_runtime, sources, policy) =>
      policy?.automaticRelay
        ? null
        : {
            name: "MessageChannel",
            description: `send:${sources[0]?.channel}`,
            parameters: {},
          },
  });
  const gateway = new ChannelGateway(client, hooks);
  await gateway.submit(
    makeDelivery({ clientMessageId: "cm-relay", sources: [makeSource()] }),
  );
  relay = false;
  client.inputResponse.disposition = "queued";
  await gateway.submit(
    makeDelivery({
      clientMessageId: "cm-tool",
      sources: [makeSource({ channel: "slack", chatId: "C-next" })],
    }),
  );

  expect(inputScope(client, 0)).toMatch(/^channel-turn-/);
  expect(inputScope(client, 1)).toBeString();
  expect(client.startedRuntimes.at(-1)?.external_tools).toHaveLength(1);
  gateway.close();
});
