import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import type { RuntimeExecutionSettings } from "@/runtime-execution-settings";
import type { RuntimeStartCommand } from "@/types/protocol_v2";
import { openListenerConnection } from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { evictConversationRuntimeIfIdle } from "@/websocket/listener/runtime";
import { isRuntimeStartCommand } from "@/websocket/listener/runtime-start-validation";
import { isInboundTeleportExpected } from "@/websocket/listener/teleport";
import type { StartListenerOptions } from "@/websocket/listener/types";
import { handleRuntimeStartCommand } from "./runtime-start";

afterEach(() => __testSetBackend(null));
test("secondary runtime_start preserves launch settings and an idle attached child retains them", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "runtime-launch-"));
  try {
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Child",
      model: "anthropic/claude-sonnet-4-6",
    } as AgentCreateBody);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const listener = createRuntime();
    const responses: Array<Record<string, unknown>> = [];
    openListenerConnection({
      runtime: listener,
      connectionId: "test",
      writer: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      options: {} as StartListenerOptions,
    });
    const context: Parameters<typeof handleRuntimeStartCommand>[1] = {
      socket: {} as WebSocket,
      connectionId: "test",
      runtime: listener,
      safeSocketSend: (_socket, data) => {
        responses.push(data as Record<string, unknown>);
        return true;
      },
      runDetachedListenerTask: () => {},
      getOrCreateScopedRuntime,
      replaySyncStateForRuntime: async () => {},
    };
    const settings: RuntimeExecutionSettings = {
      allowed_tools: ["Read"],
      disallowed_tools: ["Write"],
      parent_agent_id: "parent",
      agent_role: "subagent",
      subagent_depth: 2,
      disable_memory_guard: false,
      max_turns: 3,
    };
    const command: RuntimeStartCommand = {
      type: "runtime_start",
      request_id: "start",
      agent_id: agent.id,
      conversation_id: conversation.id,
      recover_approvals: false,
      execution_settings: settings,
    };
    expect(isRuntimeStartCommand(command)).toBe(true);
    expect(
      isRuntimeStartCommand({
        ...command,
        execution_settings: { ...settings, max_turns: -1 },
      }),
    ).toBe(false);
    await handleRuntimeStartCommand(command, context);
    const runtime = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    expect(runtime.executionSettings).toEqual(settings);
    expect(runtime.executionSettings).not.toBe(settings);
    expect(responses.at(-1)).toMatchObject({
      success: true,
      execution_settings: settings,
      max_subagent_depth: 2,
    });
    await handleRuntimeStartCommand(
      {
        ...command,
        request_id: "secondary",
        execution_settings: undefined,
        external_tools: [],
      },
      context,
    );
    expect(runtime.executionSettings).toEqual(settings);
    expect(evictConversationRuntimeIfIdle(runtime)).toBe(false);
    for (const degraded of [
      { ...settings, subagent_depth: 1 },
      { allowed_tools: [], disallowed_tools: [], disable_memory_guard: false },
    ]) {
      await handleRuntimeStartCommand(
        { ...command, execution_settings: degraded },
        context,
      );
      expect(responses.at(-1)).toMatchObject({
        success: false,
        error: "Cannot reduce subagent depth for an attached conversation",
      });
      expect(runtime.executionSettings).toEqual(settings);
    }
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: storageDir,
    });
    await handleRuntimeStartCommand(
      {
        ...command,
        request_id: "change",
        execution_settings: { ...settings, allowed_tools: ["Bash"] },
      },
      context,
    );
    expect(responses.at(-1)).toMatchObject({ success: false });
    expect(runtime.executionSettings).toEqual(settings);
    runtime.turnLifecycle.finish(lease, "end_turn");
    // A disconnected idle runtime may be evicted. Recovery must read the
    // durable marker, not keep a full runtime alive as implicit persistence.
    listener.connectionIdsByRuntimeKey.delete(runtime.key);
    expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);
    await handleRuntimeStartCommand(
      { ...command, execution_settings: undefined },
      context,
    );
    const recovered = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    expect(recovered).not.toBe(runtime);
    expect(responses.at(-1)).toMatchObject({ success: false });
    expect(String(responses.at(-1)?.error)).toContain(
      "Subagent launch restrictions were lost",
    );
    expect(recovered.executionSettings).toBeUndefined();
    expect(recovered.executionSettings?.parent_agent_id).toBeUndefined();
    await handleRuntimeStartCommand(command, context);
    expect(responses.at(-1)).toMatchObject({ success: true });
    expect(recovered.executionSettings).toEqual(settings);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a teleport destination runtime_start expects the continuation before its state replay", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "runtime-teleport-"));
  try {
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Destination",
      model: "anthropic/claude-sonnet-4-6",
    } as AgentCreateBody);
    const listener = createRuntime();
    openListenerConnection({
      runtime: listener,
      connectionId: "test",
      writer: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      options: {} as StartListenerOptions,
    });
    const expectedDuringReplay: boolean[] = [];
    const context: Parameters<typeof handleRuntimeStartCommand>[1] = {
      socket: {} as WebSocket,
      connectionId: "test",
      runtime: listener,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      getOrCreateScopedRuntime,
      replaySyncStateForRuntime: async (_listener, _socket, scope) => {
        expectedDuringReplay.push(
          isInboundTeleportExpected(
            getOrCreateScopedRuntime(
              listener,
              scope.agent_id,
              scope.conversation_id,
            ),
          ),
        );
      },
    };
    const command: RuntimeStartCommand = {
      type: "runtime_start",
      request_id: "start",
      agent_id: agent.id,
      conversation_id: "default",
      teleport_id: "teleport-1",
    };
    expect(isRuntimeStartCommand(command)).toBe(true);
    expect(isRuntimeStartCommand({ ...command, teleport_id: 7 })).toBe(false);
    await handleRuntimeStartCommand(command, context);
    expect(expectedDuringReplay).toEqual([true]);
    const runtime = getOrCreateScopedRuntime(listener, agent.id, "default");
    expect(runtime.expectedTeleportId).toBe("teleport-1");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
