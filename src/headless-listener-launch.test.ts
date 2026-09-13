import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import { createAppServerClient } from "@/app-server-client";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import type { RuntimeExecutionSettings } from "@/runtime-execution-settings";
import type {
  AgentRuntimeScope,
  LoopState,
  WsProtocolCommand,
} from "@/types/protocol_v2";
import {
  cancelListenerInput,
  launchListenerConversation,
  listenerControlUrl,
} from "./headless-listener-launch";

const scope: AgentRuntimeScope = {
  agent_id: "agent-child",
  conversation_id: "conv-child",
  acting_user_id: "user-parent",
};
const settings: RuntimeExecutionSettings = {
  parent_agent_id: "agent-parent",
  agent_role: "subagent",
  allowed_tools: ["Read"],
  disallowed_tools: ["Write"],
  disable_memory_guard: false,
  max_turns: 10,
};
function transport(supportsSettings = true) {
  const commands: WsProtocolCommand[] = [];
  let socket!: Socket;
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() {
      super();
      socket = this;
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    send(raw: string) {
      const command = JSON.parse(raw) as WsProtocolCommand;
      commands.push(command);
      if (command.type === "runtime_start")
        emit({
          type: "runtime_start_response",
          request_id: command.request_id,
          success: true,
          runtime: scope,
          agent: null,
          conversation: null,
          created: { agent: false, conversation: false },
          ...(supportsSettings
            ? { execution_settings: command.execution_settings }
            : {}),
        });
      if (command.type === "sync")
        emit({
          type: "sync_response",
          request_id: command.request_id,
          runtime: scope,
          success: true,
        });
      if (command.type === "abort_message")
        emit({
          type: "abort_message_response",
          request_id: command.request_id,
          runtime: scope,
          success: true,
          aborted: true,
        });
    }
  }
  const emit = (message: object) =>
    socket.emit("message", JSON.stringify(message));
  const client = createAppServerClient({
    url: "ws://listener.test",
    WebSocket: Socket,
    requestTimeoutMs: 100,
  });
  return { client, emit, commands };
}
function loop(clientMessageId: string, active = true): LoopState {
  return {
    status: active ? "EXECUTING_CLIENT_SIDE_TOOL" : "WAITING_ON_INPUT",
    active_run_ids: active ? ["run-own"] : [],
    executing_tool_call_ids: [],
    client_message_ids_by_run_id: {
      "run-other": ["another-message"],
      "run-own": [clientMessageId],
    },
  };
}
function receipt(clientMessageId: string): EnqueueReceipt {
  return {
    status: "queued",
    agent_id: scope.agent_id,
    conversation_id: scope.conversation_id,
    client_message_id: clientMessageId,
    workflow_id: "wf",
    super_run_id: "sr",
  };
}
const backend = {
  retrieveRun: async (id: string) =>
    ({ id, status: "completed", stop_reason: "end_turn" }) as Run,
};

test("CLI configures the listener before admitted enqueue and preserves output, usage and acting user", async () => {
  const wire = transport();
  const onMessage = mock(() => {});
  const result = await launchListenerConversation(
    {
      connectionId: "conn-target",
      scope,
      content: "hello",
      backend,
      settings,
      cwd: "/workspace",
      mode: "standard",
      onMessage,
    },
    {
      client: wire.client,
      enqueue: async (input) => {
        expect(wire.commands[0]).toMatchObject({
          type: "runtime_start",
          cwd: "/workspace",
          execution_settings: settings,
        });
        expect(input).toMatchObject({
          computer: "conn-target",
          actingUserId: "user-parent",
          content: "hello",
        });
        wire.emit({
          type: "update_loop_status",
          runtime: scope,
          loop_status: loop(input.clientMessageId),
        });
        wire.emit({
          type: "stream_delta",
          runtime: scope,
          delta: {
            type: "message",
            message_type: "usage_statistics",
            run_ids: ["run-own"],
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
            step_count: 1,
          },
        });
        wire.emit({
          type: "stream_delta",
          runtime: { ...scope, conversation_id: "other" },
          delta: {
            type: "message",
            message_type: "usage_statistics",
            total_tokens: 999,
          },
        });
        wire.emit({
          type: "update_loop_status",
          runtime: scope,
          loop_status: loop(input.clientMessageId, false),
        });
        wire.emit({
          type: "turn_finished",
          runtime: scope,
          turn_id: "turn-own",
          run_id: "run-own",
          stop_reason: "end_turn",
          usage: { total_tokens: 13, step_count: 1 },
        });
        return receipt(input.clientMessageId);
      },
      listRunMessages: async (id) => {
        expect(id).toBe("run-own");
        return [
          {
            id: "message-final",
            message_type: "assistant_message",
            date: "2026-09-12T00:00:00Z",
            content: "done",
            seq_id: 1,
          },
        ] as Message[];
      },
    },
  );
  expect(result).toMatchObject({
    text: "done",
    runIds: ["run-own"],
    usage: { total_tokens: 13, step_count: 1 },
  });
  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(wire.commands.some((command) => command.type === "input")).toBe(false);
});

test("an older listener cannot silently discard child restrictions", async () => {
  const wire = transport(false);
  const enqueue = mock(async (input: { clientMessageId: string }) =>
    receipt(input.clientMessageId),
  );
  await expect(
    launchListenerConversation(
      {
        connectionId: "conn-target",
        scope,
        content: "hello",
        backend,
        settings,
        mode: "standard",
      },
      { client: wire.client, enqueue },
    ),
  ).rejects.toThrow("does not support scoped CLI launch settings");
  expect(enqueue).not.toHaveBeenCalled();
});

test("queued CLI cancellation uses the existing dequeue API, never aborts the turn ahead", async () => {
  const wire = transport();
  const controller = new AbortController();
  const dequeue = mock(async (input: { clientMessageId: string }) => ({
    client_message_id: input.clientMessageId,
    status: "dequeued" as const,
  }));
  await expect(
    launchListenerConversation(
      {
        connectionId: "conn-target",
        scope,
        content: "hello",
        backend,
        settings,
        mode: "standard",
        signal: controller.signal,
      },
      {
        client: wire.client,
        dequeue,
        enqueue: async (input) => {
          controller.abort();
          return receipt(input.clientMessageId);
        },
      },
    ),
  ).rejects.toThrow("execution cancelled");
  expect(dequeue).toHaveBeenCalledTimes(1);
  expect(
    wire.commands.some((command) => command.type === "abort_message"),
  ).toBe(false);
});

test("active cancellation targets only a run mapped to the requested input", async () => {
  const wire = transport();
  const dequeue = async () => ({
    client_message_id: "own",
    status: "too_late" as const,
  });
  try {
    expect(
      await cancelListenerInput({
        client: wire.client,
        scope,
        clientMessageId: "own",
        dequeue,
        readState: () => ({ loop: loop("someone-else"), cancelled: false }),
      }),
    ).toBe(false);
    expect(
      wire.commands.some((command) => command.type === "abort_message"),
    ).toBe(false);
    expect(
      await cancelListenerInput({
        client: wire.client,
        scope,
        clientMessageId: "own",
        dequeue,
        readState: () => ({ loop: loop("own"), cancelled: false }),
      }),
    ).toBe(true);
    expect(wire.commands.at(-1)).toMatchObject({
      type: "abort_message",
      runtime: scope,
      run_id: "run-own",
    });
  } finally {
    wire.client.close();
  }
});

test("control URL uses the existing authenticated status relay without URL credentials", () => {
  expect(listenerControlUrl("https://api.example.test", "conn-1", scope)).toBe(
    "wss://api.example.test/v1/environments/conn-1/status/ws?agentId=agent-child&conversationId=conv-child",
  );
});

test("a completed backend run cannot hide the listener's max-turn stop", async () => {
  const wire = transport();
  await expect(
    launchListenerConversation(
      {
        connectionId: "conn-target",
        scope,
        content: "hello",
        backend,
        settings,
        mode: "standard",
      },
      {
        client: wire.client,
        enqueue: async (input) => {
          wire.emit({
            type: "update_loop_status",
            runtime: scope,
            loop_status: loop(input.clientMessageId, false),
          });
          wire.emit({
            type: "turn_finished",
            runtime: scope,
            turn_id: "turn-own",
            run_id: "run-own",
            stop_reason: "max_steps",
          });
          return receipt(input.clientMessageId);
        },
        listRunMessages: async () =>
          [
            {
              id: "message-final",
              message_type: "assistant_message",
              date: "2026-09-12T00:00:00Z",
              content: "done",
            },
          ] as Message[],
      },
    ),
  ).rejects.toThrow("max_steps");
});

function pendingRead() {
  let started!: () => void;
  let reject!: (reason?: unknown) => void;
  let aborted = false;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    entered,
    get aborted() {
      return aborted;
    },
    async read<T>(signal?: AbortSignal | null): Promise<T> {
      return new Promise<T>((_resolve, fail) => {
        reject = fail;
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            fail(signal.reason);
          },
          { once: true },
        );
        started();
      });
    },
    release() {
      reject(new Error("fixture cleanup"));
    },
  };
}

test.each(["run", "messages", "super-run"] as const)(
  "cancel interrupts a pending %s read without aborting cancellation requests",
  async (stage) => {
    const wire = transport();
    const stop = new AbortController();
    const pending = pendingRead();
    const dequeue = mock(
      async (input: { clientMessageId: string }, signal?: AbortSignal) => {
        expect(signal?.aborted).toBe(false);
        expect(signal).not.toBe(stop.signal);
        // A final answer is already complete when its message read stalls. Prove
        // cancellation reaches the server, even if that request itself fails.
        if (stage === "messages") throw new Error("cancel request reached");
        return {
          client_message_id: input.clientMessageId,
          status:
            stage === "run" ? ("too_late" as const) : ("dequeued" as const),
        };
      },
    );
    const launch = launchListenerConversation(
      {
        connectionId: "conn-target",
        scope,
        content: "hello",
        settings,
        mode: "standard",
        signal: stop.signal,
        backend: {
          retrieveRun: (id, options) =>
            stage === "run"
              ? pending.read<Run>(options?.signal)
              : backend.retrieveRun(id),
        },
      },
      {
        client: wire.client,
        dequeue,
        enqueue: async (input) => {
          if (stage !== "super-run")
            wire.emit({
              type: "update_loop_status",
              runtime: scope,
              loop_status: loop(input.clientMessageId, stage === "run"),
            });
          if (stage === "messages")
            wire.emit({
              type: "turn_finished",
              runtime: scope,
              turn_id: "turn-own",
              run_id: "run-own",
              stop_reason: "end_turn",
            });
          return receipt(input.clientMessageId);
        },
        latestSuperRun: (_id, signal) => pending.read(signal),
        listRunMessages: (_id, signal) => pending.read(signal),
      },
    );
    try {
      await pending.entered;
      stop.abort();
      expect(pending.aborted).toBe(true);
      await expect(launch).rejects.toThrow(
        stage === "messages" ? "cancel request reached" : "execution cancelled",
      );
      expect(dequeue).toHaveBeenCalledTimes(1);
      expect(wire.commands.some((c) => c.type === "abort_message")).toBe(
        stage === "run",
      );
      expect(wire.commands.some((c) => c.type === "input")).toBe(false);
    } finally {
      pending.release();
      await launch.catch(() => {});
    }
  },
);

test.each(["run", "messages", "super-run"] as const)(
  "the overall wait deadline interrupts a pending %s read without cancelling remote work",
  async (stage) => {
    const wire = transport();
    const deadline = new AbortController();
    const pending = pendingRead();
    const dequeue = mock(async () => ({
      client_message_id: "own",
      status: "dequeued" as const,
    }));
    const launch = launchListenerConversation(
      {
        connectionId: "conn-target",
        scope,
        content: "hello",
        settings,
        mode: "standard",
        backend: {
          retrieveRun: (id, options) =>
            stage === "run"
              ? pending.read<Run>(options?.signal)
              : backend.retrieveRun(id),
        },
      },
      {
        client: wire.client,
        dequeue,
        waitDeadline: deadline.signal,
        enqueue: async (input) => {
          if (stage !== "super-run")
            wire.emit({
              type: "update_loop_status",
              runtime: scope,
              loop_status: loop(input.clientMessageId, stage === "run"),
            });
          if (stage === "messages")
            wire.emit({
              type: "turn_finished",
              runtime: scope,
              turn_id: "turn-own",
              run_id: "run-own",
              stop_reason: "end_turn",
            });
          return receipt(input.clientMessageId);
        },
        latestSuperRun: (_id, signal) => pending.read(signal),
        listRunMessages: (_id, signal) => pending.read(signal),
      },
    );
    try {
      await pending.entered;
      deadline.abort(new Error("wait deadline"));
      expect(pending.aborted).toBe(true);
      await expect(launch).rejects.toThrow("execution may still be running");
      expect(dequeue).not.toHaveBeenCalled();
      expect(
        wire.commands.some(
          (c) => c.type === "abort_message" || c.type === "input",
        ),
      ).toBe(false);
    } finally {
      pending.release();
      await launch.catch(() => {});
    }
  },
);
