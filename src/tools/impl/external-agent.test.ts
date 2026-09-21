import { expect, test } from "bun:test";
import type { ExternalToolExecutor } from "@/tools/manager";
import { createExternalAgentExecutor } from "./external-agent";
import type { task } from "./task";

function result(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}
const launch = {
  action: "launch",
  arguments: {
    subagent_type: "fork",
    prompt: "Review this task",
    description: "Review",
    computer: "work-mac",
    model: "model",
  },
  first_turn_reminder: "controller-owned role",
};
const child = { agentId: "agent-parent", conversationId: "conv-child" };
const accepted = {
  status: "queued" as const,
  agent_id: child.agentId,
  conversation_id: child.conversationId,
  client_message_id: "initial-1",
  super_run_id: "super-1",
  workflow_id: "queue-1",
};

test("a controller prepares arguments and child setup around the same Agent invocation", async () => {
  const order: string[] = [];
  const controller: ExternalToolExecutor = async (_id, _name, input) => {
    const control = input._agent as Record<string, unknown>;
    order.push(String(control.phase));
    expect(input.task).toBe("domain-specific request");
    if (control.phase === "prepare") return result(launch);
    if (control.phase === "setup") {
      expect(control.child).toEqual(child);
      return result({ start: true, clientMessageId: "initial-1" });
    }
    expect(control.accepted).toEqual(accepted);
    expect(control.report).toBe("Task running");
    return result({ worker: child.conversationId });
  };
  const runAgent: typeof task = async (args, setup) => {
    expect(args).toMatchObject({ ...launch.arguments, toolCallId: "call-1" });
    expect(setup?.firstTurnReminder).toBe(launch.first_turn_reminder);
    expect(await setup?.beforeStart(child)).toEqual({
      start: true,
      clientMessageId: "initial-1",
    });
    order.push("start");
    await setup?.onInputAccepted?.(accepted);
    return "Task running";
  };
  const execute = createExternalAgentExecutor(controller, {
    runAgent,
    cloudBackend: () => true,
  });
  expect(
    (
      await execute("call-1", "any_registered_tool", {
        task: "domain-specific request",
      })
    ).isError,
  ).toBe(false);
  expect(order).toEqual(["prepare", "setup", "start", "complete"]);
});

test("controller may return an existing child without invoking Agent", async () => {
  const execute = createExternalAgentExecutor(
    async () => result({ action: "return", result: "existing child" }),
    {
      cloudBackend: () => true,
      runAgent: async () => {
        throw new Error("must not launch");
      },
    },
  );
  expect((await execute("id", "review_task", {})).content[0]?.text).toBe(
    "existing child",
  );
});

test("an explicit setup loser goes through Agent cleanup and is not started", async () => {
  const execute = createExternalAgentExecutor(
    async (_id, _name, input) =>
      result(
        (input._agent as { phase: string }).phase === "prepare"
          ? launch
          : { start: false, result: "existing", discardUnstartedFork: true },
      ),
    {
      cloudBackend: () => true,
      runAgent: async (_args, setup) => {
        const receipt = await setup!.beforeStart(child);
        expect(receipt).toEqual({
          start: false,
          result: "existing",
          discardUnstartedFork: true,
        });
        return "existing";
      },
    },
  );
  expect((await execute("id", "review", {})).content[0]?.text).toBe("existing");
});

test.each([
  { ...launch.arguments, shell: "unsafe" },
  { ...launch.arguments, subagent_type: "other" },
  { ...launch.arguments, toolCallId: "forged" },
])(
  "rejects controller arguments outside the closed Agent contract: %j",
  async (args) => {
    const execute = createExternalAgentExecutor(
      async () => result({ action: "launch", arguments: args }),
      {
        cloudBackend: () => true,
        runAgent: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect((await execute("id", "tool", {})).isError).toBe(true);
  },
);

test("setup failure and mismatched acceptance are reported without inventing another launcher", async () => {
  const execute = createExternalAgentExecutor(
    async (_id, _name, input) => {
      const phase = (input._agent as { phase: string }).phase;
      if (phase === "prepare") return result(launch);
      if (phase === "setup")
        return result({ start: true, clientMessageId: "initial-1" });
      expect((input._agent as { error: string }).error).toContain(
        "different child",
      );
      return {
        content: [{ type: "text", text: "startup failed" }],
        isError: true,
      };
    },
    {
      cloudBackend: () => true,
      runAgent: async (_args, setup) => {
        await setup!.beforeStart(child);
        await setup!.onInputAccepted!({
          ...accepted,
          conversation_id: "conv-other",
        });
        return "must not reach";
      },
    },
  );
  expect((await execute("id", "tool", {})).isError).toBe(true);
});

test("cancellation reaches Agent and setup without being supplied by the controller", async () => {
  const abort = new AbortController();
  abort.abort();
  const execute = createExternalAgentExecutor(
    async () => {
      throw new Error("must not call");
    },
    { cloudBackend: () => true },
  );
  expect(
    (
      await execute(
        "id",
        "tool",
        {},
        { tool: {} as never, signal: abort.signal },
      )
    ).isError,
  ).toBe(true);
});
