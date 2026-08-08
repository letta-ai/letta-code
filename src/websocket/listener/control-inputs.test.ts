import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { handleCwdChange } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { switchConversationWorkingDirectory } from "./cwd-change";
import { createRuntime } from "./lifecycle";
import { resetRemoteSettingsCache } from "./remote-settings";

class MockSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

describe("listener cwd change handling", () => {
  const originalHome = process.env.HOME;
  let tempHome: string | null = null;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(os.tmpdir(), "letta-control-inputs-"));
    process.env.HOME = tempHome;
    resetRemoteSettingsCache();
  });

  afterEach(async () => {
    resetRemoteSettingsCache();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = null;
    }
  });

  test("recovers a stale cwd change without exposing filesystem errors", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const missingDirectory = join(
      os.tmpdir(),
      `letta-deleted-worktree-${crypto.randomUUID()}`,
    );

    await handleCwdChange(
      {
        agentId: "agent-1",
        conversationId: "conv-1",
        cwd: missingDirectory,
      },
      socket as unknown as WebSocket,
      runtime,
    );

    expect(socket.sentPayloads).toHaveLength(1);
    const updated = JSON.parse(socket.sentPayloads[0] as string);
    expect(updated.type).toBe("update_device_status");
    expect(updated.runtime.agent_id).toBe("agent-1");
    expect(updated.runtime.conversation_id).toBe("conv-1");
    expect(updated.device_status.current_working_directory).toBe(
      listener.bootWorkingDirectory,
    );
    expect(updated.device_status.cwd_revision).toBe(1);
    expect(listener.workingDirectoryRevision).toBe(1);
    expect(runtime.reminderState.pendingSessionContextReason).toBe(
      "cwd_changed",
    );
  });

  test("automatic cwd changes reach both runtime subscribers", async () => {
    const listener = createRuntime();
    getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    for (const [connectionId, socket] of [
      ["client-a", socketA],
      ["client-b", socketB],
    ] as const) {
      openListenerConnection({
        runtime: listener,
        connectionId,
        writer: socket as never,
        options: {
          connectionId,
          wsUrl: "ws://test",
          deviceId: connectionId,
          connectionName: connectionId,
          onConnected: () => {},
          onDisconnected: () => {},
          onError: () => {},
        },
      });
      markListenerConnectionInitialized(listener, connectionId);
      subscribeListenerConnection(listener, connectionId, {
        agent_id: "agent-1",
        conversation_id: "conv-1",
      });
    }

    await switchConversationWorkingDirectory({
      runtime: listener,
      agentId: "agent-1",
      conversationId: "conv-1",
      workingDirectory: tempHome as string,
      updateCurrentRuntimeContext: false,
    });

    for (const socket of [socketA, socketB]) {
      expect(socket.sentPayloads).toHaveLength(1);
      expect(JSON.parse(socket.sentPayloads[0] ?? "{}")).toMatchObject({
        type: "update_device_status",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      });
    }
  });
});
