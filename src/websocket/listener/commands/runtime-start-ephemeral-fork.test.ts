import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import {
  isConversationMemoryReadOnly,
  setConversationMemoryReadOnly,
} from "@/runtime-context";
import { openListenerConnection } from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import type { StartListenerOptions } from "@/websocket/listener/types";
import { handleRuntimeStartCommand } from "./runtime-start";

afterEach(() => {
  __testSetBackend(null);
  setConversationMemoryReadOnly("conv-ephemeral", false);
});

test("starts a named ephemeral child under its inherited agent and rejects a different owner", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "runtime-ephemeral-fork-"));
  try {
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
    });
    __testSetBackend(backend);
    const parent = await backend.createAgent({
      name: "Parent",
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
    let creatingAgentId = parent.id;
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
      retrieveConversation: async () =>
        ({
          id: "conv-ephemeral",
          agent_id: null,
          parent_agent_id: creatingAgentId,
          name: "Joi (subagent)",
          is_subagent: true,
        }) as never,
    };
    const command = {
      type: "runtime_start" as const,
      request_id: "start",
      agent_id: parent.id,
      conversation_id: "conv-ephemeral",
    };
    await handleRuntimeStartCommand(command, context);
    expect(responses.at(-1)).toMatchObject({
      success: true,
      runtime: { agent_id: parent.id, conversation_id: "conv-ephemeral" },
      conversation: { agent_id: null, name: "Joi (subagent)" },
    });
    expect((await backend.retrieveAgent(parent.id)).name).toBe("Parent");
    expect(isConversationMemoryReadOnly("conv-ephemeral")).toBe(true);
    expect(isConversationMemoryReadOnly("default")).toBe(false);
    creatingAgentId = "agent-other";
    await handleRuntimeStartCommand(command, context);
    expect(responses.at(-1)).toMatchObject({ success: false });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
