import { expect, test } from "bun:test";
import type { WsProtocolMessage } from "@/types/app-server-protocol";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeQueueUpdate,
  TEST_RUNTIME,
} from "./gateway-test-support";

test("queue updates from older listeners may omit removal transitions", async () => {
  const client = new FakeClient({
    inputResponse: { accepted: true, disposition: "queued" },
  });
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);

  await gateway.submit(makeDelivery({ clientMessageId: "cm-mixed-version" }));

  const legacyUpdate = makeQueueUpdate([], TEST_RUNTIME) as unknown as Record<
    string,
    unknown
  >;
  delete legacyUpdate.removed;
  await expect(
    client.emitAsync(legacyUpdate as unknown as WsProtocolMessage),
  ).resolves.toBeUndefined();
  expect(
    lifecycleEvents.filter((event) => event.type === "processing"),
  ).toEqual([]);

  await client.emitAsync(
    makeQueueUpdate([], TEST_RUNTIME, [
      {
        client_message_id: "cm-mixed-version",
        disposition: "dequeued",
      },
    ]) as unknown as WsProtocolMessage,
  );
  expect(
    lifecycleEvents.filter((event) => event.type === "processing"),
  ).toHaveLength(1);

  gateway.close();
});
