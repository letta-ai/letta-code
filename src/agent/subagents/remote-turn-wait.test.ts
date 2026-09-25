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
        error: null,
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
      ({
        items: [
          {
            id: "user-1",
            date: "now",
            message_type: "user_message",
            content: "work",
            otid: "cm-1",
            run_id: "run-1",
          },
          assistant,
        ],
      }) as never,
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
            error: {
              code: "LISTENER_TURN_FAILED_BEFORE_RUN",
              message: "403 Message author is not authorized",
            },
          }) as never,
      }),
    ),
  ).rejects.toThrow(
    "Remote task failed after Cloud accepted the send [LISTENER_TURN_FAILED_BEFORE_RUN]: 403 Message author is not authorized",
  );
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

test("transient exact and child-run reads retry without failing the task", async () => {
  let exactReads = 0;
  let runReads = 0;
  const current = deps({
    exact: async () => {
      if (++exactReads === 1) throw new TypeError("fetch failed");
      return (await deps().exact(
        "agent-1",
        "sr-1",
        new AbortController().signal,
      )) as never;
    },
    backend: {
      ...deps().backend,
      retrieveRun: async () => {
        if (++runReads === 1) throw new TypeError("socket closed");
        return {
          id: "run-1",
          status: "completed",
          stop_reason: "end_turn",
        } as never;
      },
    },
  });

  expect(
    await waitForCorrelatedRemoteResult(
      receipt,
      ["run-1"],
      new AbortController().signal,
      current,
    ),
  ).toMatchObject({ text: "Done" });
  expect(exactReads).toBe(2);
  expect(runReads).toBe(2);
});

test("approval continuation resumes transcript correlation from its last cursor", async () => {
  const queries: Array<{ after?: string | null }> = [];
  const listConversationMessages = mock(
    async (_id: string, query: { after?: string | null }) => {
      queries.push(query);
      return (
        query.after
          ? [{ id: "continuation-1", run_id: "run-2" }]
          : [
              {
                id: "user-1",
                message_type: "user_message",
                otid: "cm-1",
                run_id: "run-1",
              },
            ]
      ) as never;
    },
  );
  const result = await waitForCorrelatedRemoteResult(
    receipt,
    [],
    new AbortController().signal,
    deps({
      backend: {
        ...deps().backend,
        listConversationMessages,
        retrieveRun: async (runId) =>
          ({
            id: runId,
            status: "completed",
            stop_reason: runId === "run-1" ? "requires_approval" : "end_turn",
          }) as never,
      },
    }),
  );

  expect(result).toEqual({ text: "Done", runIds: ["run-1", "run-2"] });
  expect(queries).toEqual([
    expect.not.objectContaining({ after: expect.anything() }),
    expect.objectContaining({ after: "user-1" }),
  ]);
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
