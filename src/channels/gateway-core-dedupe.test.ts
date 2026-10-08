import { expect, test } from "bun:test";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
} from "./gateway-test-support";

test("drops a resubmitted delivery whose clientMessageId was already accepted", async () => {
  // Cloud resubmits under the same stable clientMessageId when a delivery
  // activity retries or falls back to one message at a time (LET-13629). A
  // running gateway must not post the message to the model a second time.
  // A restarted listener loses this state: LET-13660.
  const client = new FakeClient();
  const { hooks, lifecycleEvents } = makeHooks();
  const gateway = new ChannelGateway(client, hooks);
  const deliveries = ["cm-chunk-1", "cm-chunk-2", "cm-chunk-3"].map(
    (clientMessageId, index) =>
      makeDelivery({
        clientMessageId,
        content: `message ${index + 1}` as ReturnType<
          typeof makeDelivery
        >["content"],
        sources: [makeSource({ messageId: `100.${index + 1}` })],
      }),
  );

  for (const delivery of deliveries) {
    expect(await gateway.submit(delivery)).toBe(true);
  }
  const queuedBeforeResubmit = lifecycleEvents.filter(
    (event) => event.type === "queued",
  ).length;

  // The whole chunk again, from the first message.
  for (const delivery of deliveries) {
    expect(await gateway.submit(delivery)).toBe(true);
  }

  expect(client.submittedInputs.map((input) => input.payload)).toHaveLength(3);
  expect(
    lifecycleEvents.filter((event) => event.type === "queued"),
  ).toHaveLength(queuedBeforeResubmit);

  gateway.close();
});
