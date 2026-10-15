import { expect, test } from "bun:test";
import { XChatDeliveryQueue } from "./delivery-queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("serializes deliveries within one X Chat conversation", async () => {
  const queue = new XChatDeliveryQueue();
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order: string[] = [];
  const first = queue.run("chat-a", async () => {
    order.push("first-start");
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push("first-end");
  });
  const second = queue.run("chat-a", async () => {
    order.push("second");
  });

  await firstStarted.promise;
  expect(order).toEqual(["first-start"]);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["first-start", "first-end", "second"]);
});

test("allows independent X Chat conversations to deliver concurrently", async () => {
  const queue = new XChatDeliveryQueue();
  const releaseFirst = deferred();
  let secondStarted = false;
  const first = queue.run("chat-a", async () => {
    await releaseFirst.promise;
  });
  const second = queue.run("chat-b", async () => {
    secondStarted = true;
  });

  await second;
  expect(secondStarted).toBe(true);
  releaseFirst.resolve();
  await first;
});
