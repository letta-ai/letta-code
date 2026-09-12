import { expect, test } from "bun:test";
import type { Backend } from "@/backend";
import type {
  ConversationStatusEvent,
  EnqueueConversationInput,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import { parseCliArgs } from "@/cli/args";
import {
  buildAgentSendReminder,
  shouldEnqueueCloudSend,
  tryCloudHeadlessSend,
} from "./headless-cloud-send";

const flags = (...args: string[]) => parseCliArgs(args, true).values;
function fixture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const submissions: EnqueueConversationInput[] = [];
  const backend = {
    capabilities: { environmentRouting: true },
    retrieveConversation: async () => ({
      id: "conv-target",
      agent_id: "agent-target",
    }),
    retrieveAgent: async (id: string) => ({
      id,
      llm_config: { model: "test-model" },
    }),
    createConversation: async () => ({ id: "conv-new" }),
    retrieveRun: async () => ({
      id: "run-1",
      status: "completed",
      stop_reason: "end_turn",
    }),
  } as unknown as Backend;
  const deps = {
    env: { AGENT_ID: "agent-parent", CONVERSATION_ID: "conv-parent" },
    writeStdout: async (text: string) => {
      stdout.push(text);
    },
    writeStderr: (text: string) => {
      stderr.push(text);
    },
    enqueue: async (input: EnqueueConversationInput) => {
      submissions.push(input);
      return {
        status: "queued" as const,
        agent_id: input.agentId,
        conversation_id: input.conversationId,
        client_message_id: input.clientMessageId,
        workflow_id: "wf-1",
        super_run_id: "sr-1",
      };
    },
    openStatusStream: async () => {
      throw new Error("no-wait must not subscribe");
    },
  };
  return { backend, deps, stdout, stderr, submissions };
}

test.each(["text", "json", "stream-json"])(
  "no-wait %s exits on HTTP acceptance with a receipt and recovery commands",
  async (format) => {
    const f = fixture();
    const result = await tryCloudHeadlessSend(
      flags(
        "--conversation",
        "conv-target",
        "--no-wait",
        "--output-format",
        format,
      ),
      "hello",
      f.backend,
      false,
      f.deps,
    );
    expect(result).toBe(0);
    expect(f.submissions).toHaveLength(1);
    const receipt = JSON.parse(f.stdout.join(""));
    expect(receipt).toMatchObject({
      status: "queued",
      agent_id: "agent-target",
      conversation_id: "conv-target",
      workflow_id: "wf-1",
      super_run_id: "sr-1",
    });
    expect(receipt.status_command).toContain("letta messages status");
    expect(receipt).not.toHaveProperty("run_id");
    expect(f.submissions[0]?.content).toContain(
      "agent-parent, conversation conv-parent",
    );
    expect(f.submissions[0]?.content).toContain(
      "use SendAgentMessage if available",
    );
    expect(f.submissions[0]?.content).toContain(
      "Ordinary assistant output is not forwarded",
    );
    expect(f.deps.env.CONVERSATION_ID).toBe("conv-parent");
  },
);

test("computer is forwarded to enqueue without a direct environment send", async () => {
  const f = fixture();
  await tryCloudHeadlessSend(
    flags(
      "--conversation",
      "conv-target",
      "--computer",
      "My laptop",
      "--no-wait",
    ),
    "hello",
    f.backend,
    false,
    f.deps,
  );
  expect(f.submissions[0]?.computer).toBe("My laptop");
});

test("empty computer never falls through to local execution, and cloud-sandbox remains an alias", async () => {
  const f = fixture();
  expect(shouldEnqueueCloudSend(flags("--computer", ""), true, false)).toBe(
    true,
  );
  expect(
    await tryCloudHeadlessSend(
      flags("--conversation", "conv-target", "--computer", "", "--no-wait"),
      "hi",
      f.backend,
      false,
      f.deps,
    ),
  ).toBe(1);
  expect(f.submissions).toHaveLength(0);
  await tryCloudHeadlessSend(
    flags(
      "--conversation",
      "conv-target",
      "--environment",
      "cloud-sandbox",
      "--no-wait",
    ),
    "hi",
    f.backend,
    false,
    f.deps,
  );
  expect(f.submissions[0]?.computer).toBe("cloud");
});

test("non-waiting output waits for HTTP acceptance, not merely the start of the request", async () => {
  const f = fixture();
  let accept = () => {};
  let observed = () => {};
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const result = tryCloudHeadlessSend(
    flags("--conversation", "conv-target", "--no-wait"),
    "hi",
    f.backend,
    false,
    {
      ...f.deps,
      enqueue: async (input) => {
        observed();
        await accepted;
        return f.deps.enqueue(input);
      },
    },
  );
  await started;
  expect(f.stdout).toHaveLength(0);
  accept();
  expect(await result).toBe(0);
  expect(JSON.parse(f.stdout.join("")).status).toBe("queued");
});

test("a network failure cannot claim the server rejected the send", async () => {
  const f = fixture();
  await tryCloudHeadlessSend(
    flags(
      "--conversation",
      "conv-target",
      "--no-wait",
      "--output-format",
      "json",
    ),
    "hi",
    f.backend,
    false,
    {
      ...f.deps,
      enqueue: async () => {
        throw new Error("connection reset");
      },
    },
  );
  expect(JSON.parse(f.stdout.join(""))).toMatchObject({
    status: "acceptance_unknown",
    conversation_id: "conv-target",
  });
});

test.each([400, 404, 409, 503])(
  "HTTP %s is returned without executing locally",
  async (status) => {
    const f = fixture();
    const result = await tryCloudHeadlessSend(
      flags(
        "--conversation",
        "conv-target",
        "--no-wait",
        "--output-format",
        "json",
      ),
      "hello",
      f.backend,
      false,
      {
        ...f.deps,
        enqueue: async () => {
          throw new ApiRequestError("rejected", status, "{}");
        },
      },
    );
    expect(result).toBe(1);
    expect(JSON.parse(f.stdout.join(""))).toMatchObject({
      http_status: status,
      is_error: true,
    });
  },
);

test("explicit sender keeps its identity but cannot borrow another sender's return conversation", async () => {
  const f = fixture();
  await tryCloudHeadlessSend(
    flags(
      "--conversation",
      "conv-target",
      "--from-agent",
      "agent-other",
      "--no-wait",
    ),
    "hello",
    f.backend,
    false,
    f.deps,
  );
  expect(f.submissions[0]?.content).toContain("agent-other");
  expect(f.submissions[0]?.content).not.toContain("conv-parent");
  expect(f.submissions[0]?.content).toContain("No return conversation");
});

test("missing sender context adds no fabricated return address", () => {
  expect(buildAgentSendReminder({}, true)).toBe("");
  expect(buildAgentSendReminder({ agentId: "agent-a" }, true)).toContain(
    "No return conversation",
  );
  expect(
    buildAgentSendReminder(
      { agentId: "agent-a", conversationId: "conv-a" },
      false,
    ),
  ).toContain("only see the final message");
});

test("unsafe IDs cannot enter a reply command", async () => {
  const f = fixture();
  const result = await tryCloudHeadlessSend(
    flags("--conversation", "conv-target", "--no-wait"),
    "hi",
    f.backend,
    false,
    {
      ...f.deps,
      env: {
        AGENT_ID: "agent-parent",
        CONVERSATION_ID: "conv-a; curl attacker",
      },
    },
  );
  expect(result).toBe(1);
  expect(f.submissions).toHaveLength(0);
});

test("two concurrent callers retain independent return addresses and message IDs", async () => {
  const a = fixture();
  const b = fixture();
  b.deps.env = { AGENT_ID: "agent-second", CONVERSATION_ID: "conv-second" };
  await Promise.all(
    [a, b].map((f) =>
      tryCloudHeadlessSend(
        flags("--conversation", "conv-target", "--no-wait"),
        "hello",
        f.backend,
        false,
        f.deps,
      ),
    ),
  );
  expect(a.submissions[0]?.content).toContain("conv-parent");
  expect(b.submissions[0]?.content).toContain("conv-second");
  expect(a.submissions[0]?.clientMessageId).not.toBe(
    b.submissions[0]?.clientMessageId,
  );
});

test("Agent fresh, resume, and fork process entrypoints are not silently rerouted", async () => {
  for (const args of [
    ["--new-agent"],
    ["--conversation", "conv-resumed"],
    ["--conversation", "conv-fork"],
    ["--agent", "agent-child", "--new"],
    ["--conversation", "conv-child", "--computer", "cloud"],
  ]) {
    const f = fixture();
    expect(
      await tryCloudHeadlessSend(
        flags(...args),
        "hello",
        f.backend,
        true,
        f.deps,
      ),
    ).toBeUndefined();
    expect(f.submissions).toHaveLength(0);
  }
});

test("Bash sends from a child use enqueue after its one-shot launch marker is consumed", () => {
  expect(
    shouldEnqueueCloudSend(flags("--conversation", "conv-parent"), true, false),
  ).toBe(true);
});

test("fresh local and App Server paths remain execution paths", () => {
  expect(
    shouldEnqueueCloudSend(flags("--conversation", "conv-local"), false, false),
  ).toBe(false);
  expect(shouldEnqueueCloudSend(flags("--new-agent"), true, false)).toBe(false);
  expect(shouldEnqueueCloudSend(flags("--agent", "agent-1"), true, false)).toBe(
    false,
  );
});

test("request-scoped tool restrictions are rejected rather than lost at enqueue", async () => {
  const f = fixture();
  expect(
    await tryCloudHeadlessSend(
      flags("--conversation", "conv-target", "--tools", "Read", "--no-wait"),
      "hi",
      f.backend,
      false,
      f.deps,
    ),
  ).toBe(1);
  expect(f.submissions).toHaveLength(0);
});

test.each(["text", "json", "stream-json"])(
  "waiting %s subscribes before submission and preserves the stdout format",
  async (format) => {
    const f = fixture();
    const order: string[] = [];
    let submitted: EnqueueConversationInput | undefined;
    const result = await tryCloudHeadlessSend(
      flags("--conversation", "conv-target", "--output-format", format),
      "hi",
      f.backend,
      false,
      {
        ...f.deps,
        openStatusStream: async () => ({
          async *[Symbol.asyncIterator](): AsyncGenerator<ConversationStatusEvent> {
            order.push("subscribed");
            yield { type: "conversation_super_run_snapshot", statuses: [] };
            if (!submitted)
              throw new Error("must submit before reading run updates");
            yield {
              type: "conversation_super_run_update",
              conversation_id: "conv-target",
              status: {
                conversation_id: "conv-target",
                active_super_runs: [],
                runtime_status: {
                  state: "ACTIVE",
                  loop_state: {
                    status: "WAITING_ON_INPUT",
                    client_message_ids_by_run_id: {
                      "run-1": [submitted.clientMessageId],
                    },
                  },
                },
              },
            };
            await new Promise(() => {});
          },
        }),
        enqueue: async (input) => {
          order.push("submitted");
          submitted = input;
          return f.deps.enqueue(input);
        },
        latestSuperRun: async () => ({
          id: "sr-1",
          status: "QUE",
          completed_at: null,
          cancelled_at: null,
          errored_at: null,
        }),
        listRunMessages: async () => [
          {
            id: "answer",
            message_type: "assistant_message",
            content: "done",
            date: "2026-09-01T00:00:00Z",
          },
        ],
      },
    );
    expect(result).toBe(0);
    expect(order).toEqual(["subscribed", "submitted"]);
    if (format === "text") expect(f.stdout.join("")).toBe("done\n");
    else if (format === "json")
      expect(JSON.parse(f.stdout.join("")).result).toBe("done");
    else {
      const events = f.stdout.map((line) => JSON.parse(line));
      expect(events.map(({ type, subtype }) => [type, subtype])).toEqual([
        ["system", "init"],
        ["result", "success"],
      ]);
      expect(events.at(-1).result).toBe("done");
    }
    expect(f.stderr.join("")).toContain('"status":"queued"');
    expect(submitted?.content).toContain("only see the final message");
  },
);
