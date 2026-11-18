import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  __resetCodexSessionsForTests,
  sendCodexMessage,
  startCodexTurn,
} from "./codex-app-server";

afterEach(__resetCodexSessionsForTests);

test("queues a slow steer while retaining the lock and applying its late reply", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const steers: number[] = [];
  let starts = 0;
  const send = (message: unknown) =>
    stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (id: number, result: unknown) => send({ id, result });
  let buffered = "";
  stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const request = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      if (typeof request.id !== "number") continue;
      switch (request.method) {
        case "initialize":
          reply(request.id, {});
          break;
        case "account/read":
          reply(request.id, { account: { type: "chatgpt" } });
          break;
        case "thread/start":
          reply(request.id, { thread: { id: "thread-queued" } });
          break;
        case "turn/start":
          starts++;
          reply(request.id, { turn: { id: "turn-queued" } });
          break;
        case "turn/steer":
          steers.push(request.id);
          if (steers.length > 1) reply(request.id, {});
          break;
      }
    }
  });
  const options = { parentAgentId: "parent", cwd: "/repo" };
  const initial = await startCodexTurn(
    { ...options, prompt: "Initial" },
    { createTransport: () => ({ stdin, stdout }) },
  );
  const receipt = await sendCodexMessage({
    ...options,
    threadId: initial.threadId,
    prompt: "First steer",
  });
  expect(receipt).toMatchObject({ mode: "steered", queued: true });
  expect(steers).toHaveLength(1);
  const next = sendCodexMessage({
    ...options,
    threadId: initial.threadId,
    prompt: "Second steer",
  });
  await Bun.sleep(0);
  expect(steers).toHaveLength(1);
  reply(steers[0] as number, {});
  expect(await next).toMatchObject({ mode: "steered" });
  expect(steers).toHaveLength(2);
  // A steered turn must not be replayed on capacity failure.
  send({
    method: "turn/completed",
    params: {
      threadId: initial.threadId,
      turn: {
        id: initial.turnId,
        status: "failed",
        error: { message: "No account capacity is available." },
      },
    },
  });
  expect((await initial.completion).success).toBe(false);
  expect(starts).toBe(1);
}, 20_000);
