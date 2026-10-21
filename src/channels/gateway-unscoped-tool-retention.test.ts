import { expect, test } from "bun:test";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  TEST_RUNTIME,
} from "./gateway-test-support";

const messageChannel = {
  name: "MessageChannel",
  description: "Send a channel message",
  parameters: { type: "object", properties: {} },
};

type Group = {
  readonly scope_id?: string;
  readonly tools: ReadonlyArray<{ name: string }>;
};

function startedGroups(client: FakeClient): Group[][] {
  return client.startedRuntimes.map(
    (started) => (started.external_tools ?? []) as Group[],
  );
}

// runtime_start replaces every tool the gateway connection registered for the
// runtime. A routed delivery must therefore re-send the host's unscoped tools,
// or turns that do not select a delivery scope (API-enqueued, proactive,
// continuations) lose MessageChannel until the runtime goes idle.
test("a routed delivery keeps the runtime's unscoped MessageChannel registered", async () => {
  const client = new FakeClient();
  const gateway = new ChannelGateway(
    client,
    makeHooks({ buildExternalTool: async () => messageChannel }).hooks,
  );
  await gateway.updateRoutedRuntimeTools(
    [
      {
        runtimes: [TEST_RUNTIME],
        external_tools: [{ tools: [messageChannel] }],
      },
    ],
    [],
  );

  await gateway.submit(makeDelivery({ clientMessageId: "cm-routed" }));

  const groups = startedGroups(client).at(-1) ?? [];
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    expect(group.scope_id).toBeUndefined();
  }
  expect(
    groups.some((group) =>
      group.tools.some((tool) => tool.name === "MessageChannel"),
    ),
  ).toBe(true);
  gateway.close();
});

// Default channel behavior (0.34.1): deliveries carry no per-delivery tool
// scope, so the listener can coalesce queued channel messages into one turn
// instead of splitting them into separate scope-keyed turns.
test("queued deliveries register no per-delivery scopes and request no turn split", async () => {
  const client = new FakeClient();
  const gateway = new ChannelGateway(
    client,
    makeHooks({ buildExternalTool: async () => messageChannel }).hooks,
  );

  await gateway.submit(makeDelivery({ clientMessageId: "cm-first" }));
  client.inputResponse.disposition = "queued";
  await gateway.submit(
    makeDelivery({
      clientMessageId: "cm-second",
      sources: [makeSource({ chatId: "chat-2" })],
    }),
  );

  expect(client.submittedInputs).toHaveLength(2);
  for (const input of client.submittedInputs) {
    const payload = input.payload as Record<string, unknown>;
    expect(payload.external_tool_scope_ids).toBeUndefined();
    expect(payload.no_coalesce).toBeUndefined();
  }
  for (const groups of startedGroups(client)) {
    for (const group of groups) {
      expect(group.scope_id).toBeUndefined();
    }
  }
  expect(
    client.runtimeToolUpdates.flatMap((update) =>
      (update.external_tools as readonly Group[]).filter(
        (group) => group.scope_id !== undefined,
      ),
    ),
  ).toEqual([]);
  gateway.close();
});
