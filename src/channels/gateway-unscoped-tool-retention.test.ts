import { expect, test } from "bun:test";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  TEST_RUNTIME,
} from "./gateway-test-support";

const messageChannel = {
  name: "MessageChannel",
  description: "Send a channel message",
  parameters: { type: "object", properties: {} },
};

type Group = { scope_id?: string; tools: Array<{ name: string }> };

// runtime_start replaces every tool the gateway connection registered for the
// runtime. A routed delivery must therefore re-send the host's unscoped tools,
// or turns that do not select the delivery scope (API-enqueued, proactive,
// continuations) lose MessageChannel until the runtime goes idle.
test("a routed delivery keeps the runtime's published unscoped tools registered", async () => {
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

  const groups = client.startedRuntimes.at(-1)?.external_tools as Group[];
  expect(
    groups.some(
      (group) =>
        group.scope_id === undefined &&
        group.tools.some((tool) => tool.name === "MessageChannel"),
    ),
  ).toBe(true);
  gateway.close();
});
