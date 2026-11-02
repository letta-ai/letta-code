import { afterEach, expect, test } from "bun:test";
import { Stream } from "@letta-ai/letta-client/core/streaming";
import { __testSetBackend, type Backend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { resumeBusyRequestStream } from "./busy-request-resume";

type StreamChunk = Awaited<
  ReturnType<Backend["streamConversationMessages"]>
> extends Stream<infer Chunk>
  ? Chunk
  : never;

function setResumeBackend(resume: Backend["streamConversationMessages"]): void {
  const backend: Backend = new FakeHeadlessBackend("agent-own");
  backend.streamConversationMessages = resume;
  __testSetBackend(backend);
}

afterEach(() => __testSetBackend(null));

test("accepted own-request recovery uses only its OTID and leaves input intact", async () => {
  const input = [
    { role: "user" as const, content: "retained", otid: "request-otid" },
  ];
  const before = JSON.stringify(input);
  let requestSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const stream = new Stream<StreamChunk>(
    async function* () {},
    new AbortController(),
  );
  setResumeBackend(async (id, body, options) => {
    expect(id).toBe("conv-own");
    expect(body).toEqual({
      agent_id: undefined,
      otid: "request-otid",
      starting_after: 0,
      batch_size: 1000,
    });
    expect(body).not.toHaveProperty("run_id");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    requestSignal = options?.signal ?? undefined;
    return stream;
  });
  expect(
    await resumeBusyRequestStream(
      "conv-own",
      "agent-own",
      input,
      controller.signal,
    ),
  ).toBe(stream);
  expect(JSON.stringify(input)).toBe(before);
  controller.abort();
  expect(requestSignal?.aborted).toBe(true);
});

test("default-conversation own-request recovery retains its agent scope", async () => {
  setResumeBackend(async (_id, body) => {
    expect(body).toMatchObject({
      agent_id: "agent-own",
      otid: "approval-otid",
    });
    return new Stream<StreamChunk>(
      async function* () {},
      new AbortController(),
    );
  });
  await resumeBusyRequestStream("default", "agent-own", [
    { type: "approval", approvals: [], otid: "approval-otid" },
  ]);
});

test("input without an OTID cannot fall back to a foreign active run", async () => {
  let requests = 0;
  setResumeBackend(async () => {
    requests++;
    throw new Error("unexpected request");
  });
  await expect(
    resumeBusyRequestStream("conv", "agent", [
      { role: "user", content: "not accepted" },
    ]),
  ).rejects.toThrow("without its OTID");
  expect(requests).toBe(0);
});

test("failed own-request lookup is surfaced without any foreign stream substitution", async () => {
  let requests = 0;
  setResumeBackend(async () => {
    requests++;
    throw new Error("OTID not indexed");
  });
  await expect(
    resumeBusyRequestStream("conv", "agent", [
      { role: "user", content: "not accepted", otid: "rejected" },
    ]),
  ).rejects.toThrow("OTID not indexed");
  expect(requests).toBe(1);
});

test("late stream acceptance after cancellation cannot escape the captured signal", async () => {
  const controller = new AbortController();
  const stream = new Stream<StreamChunk>(
    async function* () {},
    new AbortController(),
  );
  setResumeBackend(async () => {
    controller.abort(new Error("cancelled while opening"));
    return stream;
  });
  await expect(
    resumeBusyRequestStream(
      "conv",
      "agent",
      [{ role: "user", content: "retained", otid: "own" }],
      controller.signal,
    ),
  ).rejects.toThrow("cancelled while opening");
  expect(stream.controller.signal.aborted).toBe(true);
});
