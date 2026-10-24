import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import * as repositorySync from "@/agent/attached-repository-git-sync";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import type { WsProtocolMessage } from "@/types/protocol_v2";
import {
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";

test("max_turns reached while stopped for approval finishes with max_steps", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "listener-max-turns-"));
  const sync = spyOn(
    repositorySync,
    "syncPendingAttachedRepositoryCommitsAfterTurn",
  ).mockResolvedValue({ results: [] });
  const backend = new LocalBackend({
    storageDir,
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  const path = join(storageDir, "input.txt");
  await writeFile(path, "should not be read");
  const request = spyOn(
    backend,
    "createConversationMessageStream",
  ).mockImplementation(
    async () =>
      ({
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          yield {
            message_type: "approval_request_message",
            id: "message-tool",
            date: "2026-10-20T00:00:00Z",
            run_id: "run-capped",
            seq_id: 1,
            tool_call: {
              tool_call_id: "call-read",
              name: "Read",
              arguments: JSON.stringify({ file_path: path }),
            },
          };
          yield {
            message_type: "stop_reason",
            run_id: "run-capped",
            seq_id: 2,
            stop_reason: "requires_approval",
          };
          yield {
            message_type: "usage_statistics",
            run_id: "run-capped",
            seq_id: 3,
            step_count: 1,
          };
        },
      }) as unknown as Stream<LettaStreamingResponse>,
  );
  const frames: WsProtocolMessage[] = [];
  const socket = {
    kind: "local" as const,
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => {
      frames.push(JSON.parse(payload));
    },
  };
  try {
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Max turns approval",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    runtime.executionSettings = {
      allowed_tools: [],
      disallowed_tools: [],
      max_turns: 1,
      disable_memory_guard: false,
    };
    setActiveRuntime(listener);
    const options = {
      connectionId: "max-turns-test",
      wsUrl: "ws://test",
      deviceId: "test",
      connectionName: "Test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    openListenerConnection({
      runtime: listener,
      connectionId: options.connectionId,
      writer: socket,
      options,
    }).initialized = true;
    subscribeListenerConnection(listener, options.connectionId, {
      agent_id: agent.id,
      conversation_id: conversation.id,
    });

    await handleIncomingMessage(
      {
        type: "message",
        agentId: agent.id,
        conversationId: conversation.id,
        messages: [{ role: "user", content: "read the file" }],
      },
      socket,
      runtime,
    );

    // Only the capped step ran; the approved continuation never started.
    expect(request).toHaveBeenCalledTimes(1);
    expect(frames).not.toContainEqual(
      expect.objectContaining({
        type: "stream_delta",
        delta: expect.objectContaining({
          message_type: "client_tool_start",
          tool_call_id: "call-read",
        }),
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "turn_finished",
        stop_reason: "max_steps",
      }),
    );
    // The pending approval is denied on the next turn so the server isn't
    // left waiting on it.
    expect(runtime.pendingInterruptedResults).toEqual([
      expect.objectContaining({
        type: "approval",
        tool_call_id: "call-read",
        approve: false,
        reason: expect.stringContaining("Maximum turns limit reached"),
      }),
    ]);
    expect(runtime.turnLifecycle.kind).toBe("idle");
  } finally {
    request.mockRestore();
    sync.mockRestore();
    __testSetBackend(null);
    setActiveRuntime(null);
    await rm(storageDir, { recursive: true, force: true });
  }
}, 30_000);
