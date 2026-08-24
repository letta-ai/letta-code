import { expect, test } from "bun:test";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  TEST_RUNTIME,
} from "./gateway-test-support";

test("source-less observer turns preserve routed MessageChannel registration", async () => {
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);
  const routedSource = makeSource({
    channel: "slack",
    chatId: "C-observer-target",
  });

  await gateway.updateRoutedRuntimeTools(
    [],
    [{ runtime: TEST_RUNTIME, sources: [routedSource] }],
  );
  await gateway.submit(
    makeDelivery({ sources: [], clientMessageId: "cm-observer" }),
  );

  expect(client.startedRuntimes).toHaveLength(1);
  expect(client.startedRuntimes[0]?.conversation_source_tags).toEqual([
    "channel:slack",
  ]);
  expect(client.startedRuntimes[0]?.external_tools).toEqual([
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
  const processing = lifecycleEvents.find(
    (event) => event.type === "processing",
  );
  expect(processing).toMatchObject({ sources: [] });

  gateway.close();
});
