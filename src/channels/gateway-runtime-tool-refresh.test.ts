import { expect, test } from "bun:test";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";
import { createRoutedRuntimeRegistrationRefresher } from "./routed-runtime-registration";

test("an active routed refresh preserves the turn tool subscription until completion", async () => {
  const client = new FakeClient();
  let subscribedDescription: string | null = null;
  const applyUpdates = client.runtimeExternalToolsUpdate.bind(client);
  client.runtimeExternalToolsUpdate = async (options) => {
    for (const update of options.updates) {
      if (
        update.runtimes.some(
          (runtime) =>
            runtime.agent_id === TEST_RUNTIME.agent_id &&
            runtime.conversation_id === TEST_RUNTIME.conversation_id,
        )
      ) {
        subscribedDescription =
          update.external_tools[0]?.tools[0]?.description ?? null;
      }
    }
    return await applyUpdates(options);
  };
  let description = "Tool-mode schema";
  const source = makeSource({ accountId: "account-1" });
  const { hooks } = makeHooks({
    buildExternalTool: async () => ({
      name: "MessageChannel",
      description,
      parameters: {},
    }),
  });
  const gateway = new ChannelGateway(client, hooks);
  const refresher = createRoutedRuntimeRegistrationRefresher({
    registry: { resolveRoutedTurnSources: () => [source] },
    publisher: {
      getKnownRuntimes: () => gateway.getKnownRuntimes(),
      publish: (updates, routedSources) =>
        gateway.updateRoutedRuntimeTools(updates, routedSources),
    },
    channelNames: [],
    buildTool: (sources, runtime) => hooks.buildExternalTool(runtime, sources),
  });

  await refresher.refresh();
  await gateway.submit(makeDelivery({ sources: [source] }));
  subscribedDescription = "Tool-mode schema";
  description = "Relay-mode schema";

  await refresher.refresh();

  expect(subscribedDescription).toBe("Tool-mode schema");
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);
  expect(subscribedDescription).toBe("Relay-mode schema");

  refresher.close();
  gateway.close();
});

test("retries a deferred tool update rejected after turn completion", async () => {
  const client = new FakeClient();
  let updateAttempts = 0;
  client.runtimeExternalToolsUpdate = async () => {
    updateAttempts++;
    return {
      type: "runtime_external_tools_update_response",
      request_id: `deferred-${updateAttempts}`,
      success: updateAttempts > 1,
      ...(updateAttempts === 1 ? { error: "temporary rejection" } : {}),
    };
  };
  const gateway = new ChannelGateway(client, makeHooks().hooks);
  await gateway.submit(makeDelivery());
  await gateway.updateRoutedRuntimeTools(
    [{ runtimes: [TEST_RUNTIME], external_tools: [] }],
    [{ runtime: TEST_RUNTIME, sources: makeDelivery().sources }],
  );

  client.emit(makeTurnFinished("end_turn"));
  await Promise.race([
    (async () => {
      while (updateAttempts < 2) await Bun.sleep(10);
    })(),
    Bun.sleep(2500).then(() => {
      throw new Error("deferred update retry timed out");
    }),
  ]);

  expect(updateAttempts).toBe(2);
  gateway.close();
});

test("an active runtime publishes only the latest deferred schema", async () => {
  const client = new FakeClient();
  const gateway = new ChannelGateway(client, makeHooks().hooks);
  await gateway.submit(makeDelivery());
  const update = (description: string) =>
    gateway.updateRoutedRuntimeTools(
      [
        {
          runtimes: [TEST_RUNTIME],
          external_tools: [
            {
              tools: [
                {
                  name: "MessageChannel",
                  description,
                  parameters: {},
                },
              ],
            },
          ],
        },
      ],
      [{ runtime: TEST_RUNTIME, sources: makeDelivery().sources }],
    );

  await update("stale schema");
  await update("latest schema");
  client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(0);

  expect(client.runtimeToolUpdates).toHaveLength(1);
  expect(
    client.runtimeToolUpdates[0]?.external_tools[0]?.tools[0]?.description,
  ).toBe("latest schema");
  gateway.close();
});
