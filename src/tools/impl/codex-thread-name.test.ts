import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  __resetCodexSessionsForTests,
  startCodexTurn,
} from "./codex-app-server";

afterEach(() => __resetCodexSessionsForTests());

/** Replies to the startup requests; `thread/name/set` errors when unsupported. */
function fakeCodex(supportsNaming: boolean) {
  const requests: Array<{ id?: number; method: string; params?: unknown }> = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reply = (id: number, body: Record<string, unknown>) =>
    stdout.write(`${JSON.stringify({ id, ...body })}\n`);
  let buffered = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const request = JSON.parse(line);
      requests.push(request);
      if (typeof request.id !== "number") continue;
      const results: Record<string, Record<string, unknown>> = {
        initialize: {},
        "account/read": { account: { type: "chatgpt" } },
        "thread/start": { thread: { id: "thread-1" } },
        "turn/start": { turn: { id: "turn-1", status: "inProgress" } },
      };
      if (request.method === "thread/name/set" && !supportsNaming)
        reply(request.id, { error: { message: "unknown method" } });
      else reply(request.id, { result: results[request.method] ?? {} });
    }
  });
  return { requests, transport: () => ({ stdin, stdout }) };
}

for (const supportsNaming of [true, false]) {
  test(`names a new thread from the task description (supported: ${supportsNaming})`, async () => {
    const fake = fakeCodex(supportsNaming);
    const handle = await startCodexTurn(
      {
        prompt: "Work",
        parentAgentId: "p",
        cwd: "/",
        threadName: "Fix websocket reconnect hang",
      },
      { createTransport: fake.transport },
    );
    expect(handle.threadId).toBe("thread-1");
    const naming = fake.requests.find((r) => r.method === "thread/name/set");
    expect(naming?.params).toEqual({
      threadId: "thread-1",
      name: "Fix websocket reconnect hang",
    });
    expect(fake.requests.map((r) => r.method)).toContain("turn/start");
  });
}
