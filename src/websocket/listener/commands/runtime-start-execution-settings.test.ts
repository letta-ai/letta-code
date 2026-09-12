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
      disable_memory_guard: false,
      max_turns: 3,
    };
    const command: RuntimeStartCommand = {
      type: "runtime_start",
      request_id: "start",
      agent_id: agent.id,
      conversation_id: "default",
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
    const runtime = getOrCreateScopedRuntime(listener, agent.id, "default");
    expect(runtime.executionSettings).toEqual(settings);
    expect(runtime.executionSettings).not.toBe(settings);
    expect(responses.at(-1)).toMatchObject({
      success: true,
      execution_settings: settings,
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
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
