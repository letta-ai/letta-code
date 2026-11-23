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

test.each([
  ["no active turn to steer", true],
  ["No Active Turn To Steer", true],
  ["expected turn id turn-1 does not match active turn id turn-2", true],
  ["no active turn to steer", false],
  ["unrelated steer failure", false],
])("handles rejected steer %s (completion: %s)", async (message, settles) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const inputs: unknown[] = [];
  let completed = false;
  const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
  const complete = (id: string, text: string) =>
    send({
      method: "turn/completed",
      params: {
        turn: {
          id,
          status: "completed",
          items: [{ type: "agentMessage", text }],
        },
      },
    });
  let buffered = "";
  stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const request = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      if (typeof request.id !== "number") continue;
      let result: unknown = {};
      switch (request.method) {
        case "thread/start":
          result = { thread: { id: "thread-race" } };
          break;
        case "turn/start":
          inputs.push(request.params.input);
          if (inputs.length > 1) expect(completed).toBe(true);
          result = { turn: { id: `turn-${inputs.length}` } };
          break;
        case "turn/steer":
          send({ id: request.id, error: { code: -32600, message } });
          if (settles)
            setTimeout(() => {
              completed = true;
              complete("turn-1", "Original result");
            }, 10);
          continue;
      }
      send({ id: request.id, result });
    }
  });
  const options = { parentAgentId: "parent", cwd: "/repo" };
  const initial = await startCodexTurn(
    { ...options, prompt: "Initial" },
    { createTransport: () => ({ stdin, stdout }) },
  );
  const delivery = sendCodexMessage({
    ...options,
    threadId: initial.threadId,
    prompt: "Follow-up",
  });
  if (!settles) {
    await expect(delivery).rejects.toThrow(message);
    expect(inputs).toHaveLength(1);
    complete("turn-1", "Original result");
    expect(await initial.completion).toMatchObject({
      success: true,
      report: "Original result",
    });
    return;
  }
  const receipt = await delivery;
  expect(receipt).toMatchObject({ mode: "new_turn", turnId: "turn-2" });
  expect(inputs).toEqual([
    [{ type: "text", text: "Initial" }],
    [{ type: "text", text: "Follow-up" }],
  ]);
  expect(await initial.completion).toMatchObject({
    success: true,
    report: "Original result",
  });
  complete("turn-2", "Follow-up result");
  expect(await receipt.completion).toMatchObject({
    success: true,
    report: "Follow-up result",
  });
});
