import { expect, test } from "bun:test";
import type { ExternalToolExecutor } from "@/tools/manager";
import { createSlackThreadDispatchExecutor } from "./slack-thread-dispatch";
import type { task } from "./task";

const input = {
  thread_ts: "100.1",
  label: "Fix tests",
  instructions: "Inspect the failure",
  computer: "work-mac",
  model: "model",
};
const bound = {
  status: "bound",
  created: true,
  agent_id: "agent-parent",
  conversation_id: "conv-new",
  initial_client_message_id: "slack-thread:conv-new",
  initial_input_receipt: null,
};
function result(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

test("uses Agent's fork launch and waits for Cloud binding before its first turn", async () => {
  const order: string[] = [];
  const controller: ExternalToolExecutor = async (_id, _name, args) => {
    const setup = args._slack_dispatch as Record<string, unknown>;
    order.push(String(setup.operation));
    if (setup.operation === "lookup") return result({ status: "unbound" });
    expect(setup.conversation_id).toBe("conv-new");
    return result(bound);
  };
  const runAgent: typeof task = async (args, setup) => {
    expect(setup?.firstTurnReminder).toContain("ask follow-up questions");
    expect(setup?.firstTurnReminder).not.toContain("CANNOT ask");
    expect(args).toMatchObject({
      subagent_type: "fork",
      computer: "work-mac",
      model: "model",
      prompt: "Inspect the failure",
      description: "Fix tests",
      toolCallId: "call-1",
    });
    const prepared = await setup?.beforeStart({
      agentId: "agent-parent",
      conversationId: "conv-new",
    });
    expect(prepared).toEqual({
      start: true,
      clientMessageId: "slack-thread:conv-new",
    });
    order.push("start");
    await setup?.onInputAccepted?.({
      status: "queued",
      agent_id: "agent-parent",
      conversation_id: "conv-new",
      client_message_id: "slack-thread:conv-new",
      super_run_id: "super-1",
      workflow_id: "conv-queue-conv-new",
    });
    return "Task running";
  };
  const execute = createSlackThreadDispatchExecutor(controller, {
    cloudBackend: () => true,
    runAgent,
  });
  expect((await execute("call-1", "start_thread_session", input)).isError).toBe(
    false,
  );
  expect(order).toEqual(["lookup", "bind", "start"]);
});

test("repeat dispatch returns the bound worker and does not send new instructions", async () => {
  const execute = createSlackThreadDispatchExecutor(
    async () =>
      result({
        ...bound,
        created: false,
        initial_input_receipt: {
          clientMessageId: bound.initial_client_message_id,
          superRunId: "super-1",
          workflowId: "conv-queue-conv-new",
        },
      }),
    {
      cloudBackend: () => true,
      runAgent: async () => {
        throw new Error("must not run");
      },
    },
  );
  const response = await execute("id", "start_thread_session", input);
  expect(response.isError).toBe(false);
  expect(response.content[0]?.text).toContain(
    "New instructions were not delivered",
  );
});

test("a concurrent bind returns the winner without starting the new fork", async () => {
  const execute = createSlackThreadDispatchExecutor(
    async (_id, _name, args) =>
      result(
        (args._slack_dispatch as { operation: string }).operation === "lookup"
          ? { status: "unbound" }
          : { ...bound, created: false, conversation_id: "conv-winner" },
      ),
    {
      cloudBackend: () => true,
      runAgent: async (_args, setup) => {
        const response = await setup?.beforeStart({
          agentId: "agent-parent",
          conversationId: "conv-new",
        });
        expect(response).toMatchObject({
          start: false,
          discardUnstartedFork: true,
        });
        if (!response || response.start) throw new Error("must not start");
        return response.result;
      },
    },
  );
  expect((await execute("id", "start_thread_session", input)).isError).toBe(
    false,
  );
});

test("binding failure aborts the Agent call before start", async () => {
  let started = false;
  const execute = createSlackThreadDispatchExecutor(
    async (_id, _name, args) => {
      if (
        (args._slack_dispatch as { operation: string }).operation === "lookup"
      )
        return result({ status: "unbound" });
      throw new Error("binding failed");
    },
    {
      cloudBackend: () => true,
      runAgent: async (_args, setup) => {
        await setup?.beforeStart({
          agentId: "agent-parent",
          conversationId: "conv-new",
        });
        started = true;
        return "started";
      },
    },
  );
  expect((await execute("id", "start_thread_session", input)).isError).toBe(
    true,
  );
  expect(started).toBe(false);
});

test("model input cannot inject setup fields or child identity", async () => {
  let called = false;
  const execute = createSlackThreadDispatchExecutor(
    async () => {
      called = true;
      return result(bound);
    },
    { cloudBackend: () => true },
  );
  expect(
    (
      await execute("id", "start_thread_session", {
        ...input,
        _slack_dispatch: { operation: "bind", conversation_id: "conv-victim" },
      })
    ).isError,
  ).toBe(true);
  expect(called).toBe(false);
});

test("local-only runtimes fail before calling the controller", async () => {
  const execute = createSlackThreadDispatchExecutor(
    async () => {
      throw new Error("must not call");
    },
    { cloudBackend: () => false },
  );
  expect(
    (await execute("id", "start_thread_session", input)).content[0]?.text,
  ).toContain("Cloud-backed runtime");
});
