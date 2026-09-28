import { expect, test } from "bun:test";
import type { TrackChildSendInput } from "@/agent/subagents/child-send-tracking";
import type { AgentRetrieveOptions, Backend } from "@/backend";
import type { EnqueueConversationInput } from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import { runWithRuntimeContext } from "@/runtime-context";
import { send_agent_message } from "./send-agent-message";

const CLAUDE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_AGENT_ID = `claude_${CLAUDE_SESSION_ID}`;
const CODEX_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_AGENT_ID = `codex_${CODEX_THREAD_ID}`;

function fixture(targetTags: readonly string[] = []) {
  const submissions: EnqueueConversationInput[] = [];
  const created: unknown[] = [];
  const tracked: TrackChildSendInput[] = [];
  const backend = {
    capabilities: { environmentRouting: true },
    retrieveAgent: async (id: string, options?: AgentRetrieveOptions) => ({
      id,
      name: "Hayt",
      // Cloud only returns tags when explicitly included.
      tags: options?.include?.includes("agent.tags") ? targetTags : [],
    }),
    retrieveConversation: async (id: string) => ({
      id,
      agent_id: "agent-target",
    }),
    createConversation: async (input: unknown) => {
      created.push(input);
      return { id: "conv-new" };
    },
  } as unknown as Backend;
  const enqueue = async (input: EnqueueConversationInput) => {
    submissions.push(input);
    return {
      status: "queued" as const,
      agent_id: input.agentId,
      conversation_id: input.conversationId,
      client_message_id: input.clientMessageId,
      workflow_id: "wf-1",
      super_run_id: "sr-1",
    };
  };
  const trackChildSend = (input: TrackChildSendInput) => {
    tracked.push(input);
    return "subagent-tracked";
  };
  return { backend, enqueue, trackChildSend, submissions, created, tracked };
}

const caller = {
  agentId: "agent-caller",
  conversationId: "conv-caller",
  actingUserId: "user-caller",
};
const message = {
  conversation_id: "conv-target",
  message: "Please check the tests.",
};

test("resumes an external coding-agent session without the Cloud backend", async () => {
  const f = fixture();
  f.backend.capabilities.environmentRouting = false;
  const launches: unknown[] = [];
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      {
        agent_id: CLAUDE_AGENT_ID,
        message: "Now fix the test.",
      },
      {
        ...f,
        sendClaudeMessage: async () => ({
          mode: "resumed",
          sessionId: CLAUDE_SESSION_ID,
          completion: Promise.resolve({
            agentId: CLAUDE_AGENT_ID,
            report: "done",
            success: true,
          }),
          interrupt: async () => undefined,
        }),
        trackExternalFollowup: (input) => {
          launches.push(input);
          return {
            taskId: "task-followup",
            outputFile: "/tmp/task-followup.log",
            subagentId: "subagent-followup",
          };
        },
      },
    ),
  );
  expect(result.status).toBe("success");
  expect(JSON.parse(result.content)).toEqual({
    status: "accepted",
    agent_id: CLAUDE_AGENT_ID,
    delivery: "resume/start",
    task_id: "task-followup",
    output_file: "/tmp/task-followup.log",
  });
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({
    type: "claude-code",
    agentId: CLAUDE_AGENT_ID,
    message: "Now fix the test.",
    parentScope: {
      agentId: "agent-caller",
      conversationId: "conv-caller",
    },
    completion: expect.any(Promise),
    interrupt: expect.any(Function),
  });
  expect(f.submissions).toHaveLength(0);
});

test("aborts an external turn when background tracking cannot be created", async () => {
  const f = fixture();
  let interrupts = 0;
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      { agent_id: CLAUDE_AGENT_ID, message: "Continue" },
      {
        ...f,
        sendClaudeMessage: async () => ({
          mode: "resumed",
          sessionId: CLAUDE_SESSION_ID,
          completion: new Promise(() => undefined),
          interrupt: async () => {
            interrupts++;
          },
        }),
        trackExternalFollowup: () => {
          throw new Error("Background task limit reached");
        },
      },
    ),
  );
  expect(result.status).toBe("error");
  expect(result.content).toContain("Background task limit reached");
  expect(interrupts).toBe(1);
});

test("steers an active Codex app-server turn without exec resume", async () => {
  const f = fixture();
  const sends: unknown[] = [];
  const launches: unknown[] = [];
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      { agent_id: CODEX_AGENT_ID, message: "Change direction" },
      {
        ...f,
        sendCodexMessage: async (input) => {
          sends.push(input);
          return {
            mode: "steered",
            threadId: CODEX_THREAD_ID,
            turnId: "turn-1",
          };
        },
        trackExternalFollowup: (input) => {
          launches.push(input);
          throw new Error("must not track a new followup");
        },
      },
    ),
  );
  expect(result.status).toBe("success");
  expect(JSON.parse(result.content)).toMatchObject({
    delivery: "turn/steer",
    turn_id: "turn-1",
  });
  expect(sends).toHaveLength(1);
  expect(launches).toHaveLength(0);
});

test("tracks an idle Codex new turn through background lifecycle", async () => {
  const f = fixture();
  const tracked: unknown[] = [];
  const completion = Promise.resolve({
    agentId: CODEX_AGENT_ID,
    runtimeSessionId: CODEX_THREAD_ID,
    report: "done",
    success: true,
  });
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      { agent_id: CODEX_AGENT_ID, message: "Continue" },
      {
        ...f,
        sendCodexMessage: async () => ({
          mode: "new_turn",
          threadId: CODEX_THREAD_ID,
          turnId: "turn-2",
          completion,
          interrupt: async () => undefined,
        }),
        trackExternalFollowup: (input) => {
          tracked.push(input);
          return {
            taskId: "task-codex",
            outputFile: "/tmp/task-codex.log",
            subagentId: "subagent-codex",
          };
        },
      },
    ),
  );
  expect(JSON.parse(result.content)).toMatchObject({
    delivery: "turn/start",
    task_id: "task-codex",
    output_file: "/tmp/task-codex.log",
  });
  expect(tracked).toHaveLength(1);
  expect(tracked[0]).toMatchObject({
    agentId: CODEX_AGENT_ID,
    completion,
    interrupt: expect.any(Function),
  });
});

test.each([{ conversation_id: "conv-target" }, { computer: "cloud" }])(
  "rejects incompatible external coding-agent routing: %j",
  async (extra) => {
    const f = fixture();
    const result = await runWithRuntimeContext(caller, () =>
      send_agent_message(
        {
          agent_id: CODEX_AGENT_ID,
          message: "Continue",
          ...extra,
        },
        f,
      ),
    );
    expect(result.status).toBe("error");
    expect(f.submissions).toHaveLength(0);
  },
);

test.each(["conv-caller", "default"])(
  "rejects the tool's current conversation %s before enqueue",
  async (conversationId) => {
    const f = fixture();
    f.backend.retrieveConversation = async (id) =>
      ({ id, agent_id: caller.agentId }) as Awaited<
        ReturnType<Backend["retrieveConversation"]>
      >;
    const result = await runWithRuntimeContext(
      { ...caller, conversationId },
      () =>
        send_agent_message(
          {
            agent_id: caller.agentId,
            conversation_id: conversationId,
            message: "Wake up",
          },
          f,
        ),
    );
    expect(result.status).toBe("error");
    expect(JSON.parse(result.content).error).toBe(
      "Cannot message the current conversation. Use Monitor for external events or Wake for timed self-invocation.",
    );
    expect(f.submissions).toHaveLength(0);
    expect(f.created).toHaveLength(0);
  },
);

test.each(["conv-fork", "default", undefined])(
  "allows the same agent in another tool destination %s",
  async (conversationId) => {
    const f = fixture();
    f.backend.retrieveConversation = async (id) =>
      ({ id, agent_id: caller.agentId }) as Awaited<
        ReturnType<Backend["retrieveConversation"]>
      >;
    const result = await runWithRuntimeContext(caller, () =>
      send_agent_message(
        {
          agent_id: caller.agentId,
          conversation_id: conversationId,
          message: "Hello fork",
        },
        f,
      ),
    );
    expect(result.status).toBe("success");
    expect(f.submissions).toHaveLength(1);
  },
);

test("returns acceptance and an explicit return address, with no task or answer", async () => {
  const f = fixture();
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, f),
  );
  expect(result.status).toBe("success");
  const receipt = JSON.parse(result.content);
  expect(receipt).toMatchObject({
    status: "queued",
    agent_id: "agent-target",
    conversation_id: "conv-target",
    super_run_id: "sr-1",
  });
  expect(receipt).not.toHaveProperty("task_id");
  expect(receipt).not.toHaveProperty("result");
  expect(receipt.status_command).toContain("--conversation conv-target");
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]).toMatchObject({ actingUserId: "user-caller" });
  expect(f.submissions[0]?.content).toEqual([
    {
      type: "text",
      text: expect.stringContaining("agent-caller, conversation conv-caller"),
    },
    { type: "text", text: message.message },
  ]);
  expect(JSON.stringify(f.submissions[0]?.content)).toContain(
    "Ordinary assistant output is not forwarded",
  );
});

test("does not return queued until the server accepts", async () => {
  const f = fixture();
  let accept!: () => void;
  let started!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished = false;
  const result = runWithRuntimeContext(caller, () =>
    send_agent_message(message, {
      ...f,
      enqueue: async (input) => {
        started();
        await accepted;
        return f.enqueue(input);
      },
    }),
  ).then((value) => {
    finished = true;
    return value;
  });
  await sending;
  expect(finished).toBe(false);
  accept();
  expect((await result).status).toBe("success");
});

test("overlapping senders keep their own conversation, acting user, and message ID", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runWithRuntimeContext(caller, () =>
    send_agent_message(message, {
      ...f,
      enqueue: async (input) => {
        await gate;
        return f.enqueue(input);
      },
    }),
  );
  const second = runWithRuntimeContext(
    {
      agentId: "agent-second",
      conversationId: "conv-second",
      actingUserId: "user-second",
    },
    () => send_agent_message({ ...message, message: "Second sender" }, f),
  );
  await second;
  release();
  await first;
  expect(f.submissions[0]).toMatchObject({ actingUserId: "user-second" });
  expect(JSON.stringify(f.submissions[0]?.content)).toContain(
    "agent-second, conversation conv-second",
  );
  expect(f.submissions[1]).toMatchObject({ actingUserId: "user-caller" });
  expect(JSON.stringify(f.submissions[1]?.content)).toContain(
    "agent-caller, conversation conv-caller",
  );
  expect(f.submissions[0]?.clientMessageId).not.toBe(
    f.submissions[1]?.clientMessageId,
  );
});

test.each([
  {},
  { agentId: null, conversationId: null },
  { agentId: "agent-caller" },
])("missing caller scope never borrows process identity: %j", async (scope) => {
  const f = fixture();
  const result = await runWithRuntimeContext(scope, () =>
    send_agent_message(message, f),
  );
  expect(result.status).toBe("error");
  expect(f.submissions).toHaveLength(0);
});

test("agent-only sends create a hidden conversation; default requires its agent", async () => {
  const f = fixture();
  const send = (args: Parameters<typeof send_agent_message>[0]) =>
    runWithRuntimeContext(caller, () => send_agent_message(args, f));
  expect(
    (await send({ agent_id: "agent-target", message: "hello" })).status,
  ).toBe("success");
  expect(f.created).toEqual([{ agent_id: "agent-target", hidden: true }]);
  expect(f.submissions[0]?.conversationId).toBe("conv-new");
  expect(
    (await send({ conversation_id: "default", message: "hello" })).status,
  ).toBe("error");
  expect(
    (
      await send({
        agent_id: "agent-target",
        conversation_id: "default",
        message: "hello",
      })
    ).status,
  ).toBe("success");
  expect(f.submissions[1]?.conversationId).toBe("default");
  expect(f.created).toHaveLength(1);
});

test.each([
  { message: "hello" },
  { ...message, message: " " },
  { ...message, conversation_id: "conv-target; echo bad" },
  { ...message, agent_id: "agent-wrong" },
])(
  "invalid destination or input is rejected without submission: %j",
  async (args) => {
    const f = fixture();
    expect(
      (await runWithRuntimeContext(caller, () => send_agent_message(args, f)))
        .status,
    ).toBe("error");
    expect(f.submissions).toHaveLength(0);
    expect(f.created).toHaveLength(0);
  },
);

test.each([
  undefined,
  null,
  "",
  " \t\n",
  "desktop",
  "conn-target",
  " Cloud-Sandbox ",
])("computer selection preserves the CLI behavior: %s", async (computer) => {
  const f = fixture();
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message({ ...message, computer }, f),
  );
  expect(result.status).toBe("success");
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]?.computer).toBe(
    computer === " Cloud-Sandbox " ? "cloud" : computer?.trim() || undefined,
  );
});

test.each([403, 409, 503, "network"])(
  "delivery errors are surfaced without retries: %s",
  async (failure) => {
    const f = fixture();
    let attempts = 0;
    const result = await runWithRuntimeContext(caller, () =>
      send_agent_message(message, {
        ...f,
        enqueue: async () => {
          attempts++;
          throw typeof failure === "number"
            ? new ApiRequestError("refused", failure, "refused")
            : new Error("connection reset");
        },
      }),
    );
    expect(result.status).toBe("error");
    expect(attempts).toBe(1);
    const receipt = JSON.parse(result.content);
    expect(receipt.status).toBe(
      failure === 403 || failure === 409
        ? "submission_failed"
        : "acceptance_unknown",
    );
    expect(receipt.conversation_id).toBe("conv-target");
  },
);

test("a typed pre-admission shutdown 503 is a failed submission, not unknown acceptance", async () => {
  const f = fixture();
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, {
      ...f,
      enqueue: async () => {
        throw new ApiRequestError(
          "rejected",
          503,
          JSON.stringify({
            errorCode: "cloud_api_shutting_down",
            admitted: false,
            retryable: true,
          }),
        );
      },
    }),
  );
  expect(result.status).toBe("error");
  expect(JSON.parse(result.content)).toMatchObject({
    status: "submission_failed",
    http_status: 503,
  });
});

test("local backend and cancellation do not dispatch or fall back to execution", async () => {
  const f = fixture();
  f.backend.capabilities.environmentRouting = false;
  expect(
    (await runWithRuntimeContext(caller, () => send_agent_message(message, f)))
      .status,
  ).toBe("error");
  f.backend.capabilities.environmentRouting = true;
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await runWithRuntimeContext(caller, () =>
        send_agent_message({ ...message, signal: controller.signal }, f),
      )
    ).status,
  ).toBe("error");
  expect(f.submissions).toHaveLength(0);
  expect(f.created).toHaveLength(0);
});

test("cancelling an in-flight submission preserves uncertain acceptance without resending", async () => {
  const f = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let attempts = 0;
  const result = runWithRuntimeContext(caller, () =>
    send_agent_message(
      { ...message, signal: controller.signal },
      {
        ...f,
        enqueue: async (_input, signal) => {
          attempts++;
          started();
          return new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
    ),
  );
  await sending;
  controller.abort();
  const outcome = await result;
  expect(outcome.status).toBe("error");
  expect(JSON.parse(outcome.content).status).toBe("acceptance_unknown");
  expect(attempts).toBe(1);
});

test("a send to this agent's own subagent is tracked against the receipt", async () => {
  const f = fixture(["type:code-reviewer", "parent:agent-caller"]);
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, f),
  );
  expect(result.status).toBe("success");
  expect(f.tracked).toHaveLength(1);
  expect(f.tracked[0]).toMatchObject({
    receipt: { agent_id: "agent-target", super_run_id: "sr-1" },
    child: { name: "Hayt", type: "code-reviewer" },
    prompt: message.message,
    parentScope: { agentId: "agent-caller", conversationId: "conv-caller" },
  });
});

test.each([
  { tags: [] },
  { tags: ["type:general-purpose", "parent:agent-someone-else"] },
])(
  "a send to a peer agent is never tracked as a subagent: %j",
  async ({ tags }) => {
    const f = fixture(tags);
    const result = await runWithRuntimeContext(caller, () =>
      send_agent_message(message, f),
    );
    expect(result.status).toBe("success");
    expect(f.submissions).toHaveLength(1);
    expect(f.tracked).toHaveLength(0);
  },
);

test("a failed child lookup still delivers and skips tracking", async () => {
  const f = fixture(["parent:agent-caller"]);
  f.backend.retrieveAgent = async () => {
    throw new ApiRequestError("gone", 404, "gone");
  };
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, f),
  );
  expect(result.status).toBe("success");
  expect(f.submissions).toHaveLength(1);
  expect(f.tracked).toHaveLength(0);
});

test("a rejected enqueue to a child is not tracked", async () => {
  const f = fixture(["parent:agent-caller"]);
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, {
      ...f,
      enqueue: async () => {
        throw new ApiRequestError("refused", 403, "refused");
      },
    }),
  );
  expect(result.status).toBe("error");
  expect(f.tracked).toHaveLength(0);
});
