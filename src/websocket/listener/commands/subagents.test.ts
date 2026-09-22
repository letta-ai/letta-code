import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import {
  getRuntimeContext,
  type RuntimeContextSnapshot,
  runWithRuntimeContext,
} from "@/runtime-context";
import { getWorkingDirectoryScopeKey } from "@/websocket/listener/cwd";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import { handleLaunchSubagentCommand } from "./subagents";

const cwdA = tmpdir();
const cwdB = process.cwd();
const args = {
  subagent_type: "custom",
  conversation_id: "conv-worker",
  prompt: "Work",
  description: "Worker",
  client_message_id: "assignment:initial-input",
};

describe("subagent command context", () => {
  test("times out startup without changing the parent turn", async () => {
    const parent = createConversationRuntime(
      createRuntime(),
      "agent-a",
      "conv-a",
    );
    const lease = parent.turnLifecycle.begin({
      origin: "message",
      workingDirectory: cwdA,
    });
    const release = Promise.withResolvers<void>();
    let launchSignal: AbortSignal | undefined;
    const response = await handleLaunchSubagentCommand(
      {
        type: "launch_subagent",
        request_id: "slow-launch",
        runtime: { agent_id: "agent-a", conversation_id: "conv-a" },
        args,
      },
      parent,
      undefined,
      async (input) => {
        launchSignal = input.signal;
        expect(launchSignal).toBeDefined();
        await release.promise;
        return { success: false, error: "Late launch result" };
      },
      1,
    );
    release.resolve();
    expect(response).toMatchObject({
      success: false,
      error: "Subagent launch timed out",
    });
    expect(launchSignal?.aborted).toBe(true);
    expect(parent.turnLifecycle.currentLease).toBe(lease);
    parent.turnLifecycle.finish(lease, "end_turn");
  });

  test("concurrent launches capture their parent context without changing active turns", async () => {
    const listener = createRuntime();
    const a = createConversationRuntime(listener, "agent-a", "conv-a");
    const b = createConversationRuntime(listener, "agent-b", "conv-b");
    listener.workingDirectoryByConversation.set(
      getWorkingDirectoryScopeKey("agent-a", "conv-a"),
      cwdA,
    );
    listener.workingDirectoryByConversation.set(
      getWorkingDirectoryScopeKey("agent-b", "conv-b"),
      cwdB,
    );
    const lease = a.turnLifecycle.begin({
      origin: "message",
      workingDirectory: cwdA,
    });
    a.turnLifecycle.setExecutingToolCallIds(lease, ["dispatch"]);
    a.turnLifecycle.setStatus(lease, "EXECUTING_CLIENT_SIDE_TOOL");
    const before = a.turnLifecycle.snapshot();
    const release = Promise.withResolvers<void>();
    const contexts: RuntimeContextSnapshot[] = [];
    const launch: Parameters<typeof handleLaunchSubagentCommand>[3] = async (
      input,
    ) => {
      await release.promise;
      contexts.push({ ...getRuntimeContext() });
      expect(input.client_message_id).toBe(args.client_message_id);
      expect(input.parentScope?.conversationId).toBe(
        getRuntimeContext()?.conversationId ?? undefined,
      );
      return {
        success: true,
        task_id: "task",
        agent_id: "agent-worker",
        conversation_id: "conv-worker",
        output_file: "out",
      };
    };
    await runWithRuntimeContext(
      {
        agentId: "unrelated",
        actingUserId: "unrelated",
        toolContextId: "unrelated",
      },
      async () => {
        const pending = [a, b].map((parent, i) =>
          handleLaunchSubagentCommand(
            {
              type: "launch_subagent",
              request_id: String(i),
              runtime: {
                agent_id: parent.agentId as string,
                conversation_id: parent.conversationId,
                acting_user_id: `user-${i}`,
              },
              args,
            },
            parent,
            undefined,
            launch,
          ),
        );
        release.resolve();
        expect(
          (await Promise.all(pending)).every((result) => result.success),
        ).toBe(true);
        expect(getRuntimeContext()?.agentId).toBe("unrelated");
      },
    );
    expect(contexts).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        conversationId: "conv-a",
        actingUserId: "user-0",
        workingDirectory: cwdA,
      }),
      expect.objectContaining({
        agentId: "agent-b",
        conversationId: "conv-b",
        actingUserId: "user-1",
        workingDirectory: cwdB,
      }),
    ]);
    expect(
      contexts.every((context) => context.toolContextId === undefined),
    ).toBe(true);
    expect(a.turnLifecycle.snapshot()).toEqual(before);
    expect(b.turnLifecycle.kind).toBe("idle");
    a.turnLifecycle.finish(lease, "end_turn");
  });

  test("startup errors return a correlated failure without completing the parent turn", async () => {
    const parent = createConversationRuntime(
      createRuntime(),
      "agent-a",
      "conv-a",
    );
    const lease = parent.turnLifecycle.begin({
      origin: "message",
      workingDirectory: cwdA,
    });
    const response = await handleLaunchSubagentCommand(
      {
        type: "launch_subagent",
        request_id: "failed-launch",
        runtime: { agent_id: "agent-a", conversation_id: "conv-a" },
        args,
      },
      parent,
      undefined,
      async () => {
        throw new Error("Child unavailable");
      },
    );
    expect(response).toEqual({
      type: "launch_subagent_response",
      request_id: "failed-launch",
      success: false,
      error: "Child unavailable",
    });
    expect(parent.turnLifecycle.currentLease).toBe(lease);
    parent.turnLifecycle.finish(lease, "end_turn");
  });
});
