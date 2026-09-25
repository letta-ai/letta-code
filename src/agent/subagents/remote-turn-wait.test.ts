import { expect, mock, test } from "bun:test";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import {
  type RemoteResultWaitDeps,
  readCorrelatedRunIds,
  waitForCorrelatedRemoteResult,
} from "./remote-turn-wait";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "cm-1",
  super_run_id: "sr-1",
  workflow_id: "wf-1",
};

const assistant = {
  id: "assistant-1",
  date: "now",
  message_type: "assistant_message" as const,
  content: "Done",
  run_id: "run-1",
  seq_id: 2,
};

function deps(
  overrides: Partial<RemoteResultWaitDeps> = {},
): RemoteResultWaitDeps {
  return {
    backend: {
      listConversationMessages: async () => [] as never,
      listAgentMessages: async () => [] as never,
      retrieveRun: async (id) =>
        ({ id, status: "completed", stop_reason: "end_turn" }) as never,
    },
    exact: async () =>
      ({
        id: "sr-1",
        status: "COM",
        completed_at: "now",
        cancelled_at: null,
        errored_at: null,
      }) as never,
    listRunMessages: async () => [assistant] as never,
    pollMs: 0,
    resultGraceMs: 0,
    sleep: async () => {},
    ...overrides,
  };
}

test("requires a correlated completed child run and assistant result", async () => {
  const result = await waitForCorrelatedRemoteResult(
    receipt,
    ["run-1"],
    new AbortController().signal,
    deps(),
  );

  expect(result).toEqual({ text: "Done", runIds: ["run-1"] });
});

test("recovers a fast completed run from the accepted send's durable OTID", async () => {
  const listConversationMessages = mock(
    async () =>
      [
        {
          id: "user-1",
          date: "now",
          message_type: "user_message",
          content: "work",
          otid: "cm-1",
          run_id: "run-1",
        },
        assistant,
      ] as never,
  );
  const result = await waitForCorrelatedRemoteResult(
    receipt,
    [],
    new AbortController().signal,
    deps({
      backend: {
        ...deps().backend,
        listConversationMessages,
      },
    }),
  );

  expect(listConversationMessages).toHaveBeenCalled();
  expect(result.runIds).toEqual(["run-1"]);
});

test("default conversations recover correlation through agent messages", async () => {
  const listAgentMessages = mock(
    async () =>
      [
        {
          id: "user-1",
          date: "now",
          message_type: "user_message",
          content: "work",
          otid: "cm-1",
          run_id: "run-1",
        },
      ] as never,
  );
  const listConversationMessages = mock(async () => [] as never);
  const current = {
    ...receipt,
    conversation_id: "default",
  };

  expect(
    await readCorrelatedRunIds(
      current,
      {
        ...deps().backend,
        listAgentMessages,
        listConversationMessages,
      },
      new AbortController().signal,
    ),
  ).toEqual(["run-1"]);
  expect(listAgentMessages).toHaveBeenCalledWith(
    "agent-1",
    expect.objectContaining({ conversation_id: "default", order: "asc" }),
    expect.anything(),
  );
  expect(listConversationMessages).not.toHaveBeenCalled();
});

test("durable correlation keeps the abort signal while paging", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `user-${index}`,
    message_type: "user_message",
    otid: index === 99 ? "cm-1" : `older-${index}`,
  }));
  const listConversationMessages = mock(
    async (_id: string, query: { after?: string | null }) =>
      (query.after
        ? [{ id: "assistant-1", run_id: "run-1" }]
        : firstPage) as never,
  );
  const signal = new AbortController().signal;

  expect(
    await readCorrelatedRunIds(
      receipt,
      { ...deps().backend, listConversationMessages },
      signal,
    ),
  ).toEqual(["run-1"]);
  expect(listConversationMessages).toHaveBeenLastCalledWith(
    "conv-1",
    expect.objectContaining({ after: "user-99" }),
    { signal },
  );
});

test("a later user turn cannot supply the accepted send's result", async () => {
  const runIds = await readCorrelatedRunIds(
    receipt,
    {
      ...deps().backend,
      listConversationMessages: async () =>
        [
          {
            id: "user-1",
            message_type: "user_message",
            otid: "cm-1",
            run_id: "run-1",
          },
          {
            id: "user-2",
            message_type: "user_message",
            otid: "cm-2",
            run_id: "run-2",
          },
          { id: "assistant-2", run_id: "run-2" },
        ] as never,
    },
    new AbortController().signal,
  );

  expect(runIds).toEqual(["run-1"]);
});

test("a false COM without a child run is an execution failure", async () => {
  await expect(
    waitForCorrelatedRemoteResult(
      receipt,
      [],
      new AbortController().signal,
      deps(),
    ),
  ).rejects.toThrow("completed without a correlated child run");
});

test("a post-accept pre-run error wins over a COM row", async () => {
  await expect(
    waitForCorrelatedRemoteResult(
      receipt,
      [],
      new AbortController().signal,
      deps({
        exact: async () =>
          ({
            id: "sr-1",
            status: "COM",
            completed_at: "now",
            cancelled_at: null,
            errored_at: "now",
          }) as never,
      }),
    ),
  ).rejects.toThrow("finished with an error");
});

test("a failed correlated child run is an execution failure", async () => {
  await expect(
    waitForCorrelatedRemoteResult(
      receipt,
      ["run-1"],
      new AbortController().signal,
      deps({
        backend: {
          ...deps().backend,
          retrieveRun: async () =>
            ({
              id: "run-1",
              status: "failed",
              stop_reason: "error",
            }) as never,
        },
      }),
    ),
  ).rejects.toThrow("run-1 failed (error)");
});

test("a cancelled correlated child run is an execution failure", async () => {
  await expect(
    waitForCorrelatedRemoteResult(
      receipt,
      ["run-1"],
      new AbortController().signal,
      deps({
        backend: {
          ...deps().backend,
          retrieveRun: async () =>
            ({ id: "run-1", status: "cancelled" }) as never,
        },
      }),
    ),
  ).rejects.toThrow("run-1 cancelled");
});

test("waits for a completed run's assistant result to persist", async () => {
  let reads = 0;
  let time = 0;
  const result = await waitForCorrelatedRemoteResult(
    receipt,
    ["run-1"],
    new AbortController().signal,
    deps({
      listRunMessages: async () => (++reads === 1 ? [] : [assistant]) as never,
      resultGraceMs: 10,
      now: () => time,
      sleep: async () => {
        time++;
      },
    }),
  );

  expect(reads).toBe(2);
  expect(result.text).toBe("Done");
});

test("a completed run without an assistant result is an execution failure", async () => {
  await expect(
    waitForCorrelatedRemoteResult(
      receipt,
      ["run-1"],
      new AbortController().signal,
      deps({ listRunMessages: async () => [] }),
    ),
  ).rejects.toThrow("completed without an assistant reply");
});
