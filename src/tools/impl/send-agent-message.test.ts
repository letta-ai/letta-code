import { expect, test } from "bun:test";
import type { Backend } from "@/backend";
import type { EnqueueConversationInput } from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import { runWithRuntimeContext } from "@/runtime-context";
import { send_agent_message } from "./send-agent-message";

function fixture() {
  const submissions: EnqueueConversationInput[] = [];
  const created: unknown[] = [];
  const backend = {
    capabilities: { environmentRouting: true },
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
  return { backend, enqueue, submissions, created };
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
      "Cannot message the current conversation. Use a Monitor or schedule for self-invocation.",
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
