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
  readonly tools: ReadonlyArray<{ name: string }>;
};

function startedGroups(client: FakeClient): Group[][] {
  return client.startedRuntimes.map(
    (started) => (started.external_tools ?? []) as Group[],
  );
}

test("a routed delivery keeps the runtime's MessageChannel registered", async () => {
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
  expect(
    groups.some((group) =>
      group.tools.some((tool) => tool.name === "MessageChannel"),
    ),
  ).toBe(true);
  gateway.close();
});

test("queued deliveries request no turn split", async () => {
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
    expect(payload.no_coalesce).toBeUndefined();
  }
  gateway.close();
});
