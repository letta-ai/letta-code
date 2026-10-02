import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setExternalCodingAgentTaskDirectoryForTests,
  createExternalCodingAgentTaskStore,
} from "@/tools/impl/external-agent-record";
import { clearPendingMessages } from "@/utils/message-queue-bridge";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { setActiveRuntime } from "./runtime";
import { LocalListenerTransport } from "./transport";
import type { IncomingMessage } from "./types";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "interrupted-external-agents-"));
  __setExternalCodingAgentTaskDirectoryForTests(directory);
});

afterEach(() => {
  __setExternalCodingAgentTaskDirectoryForTests(undefined);
  rmSync(directory, { recursive: true, force: true });
});

test("a restarted listener wakes the parent of a Claude Code task the restart killed", async () => {
  // The record a previous listener process left behind when the sandbox died.
  createExternalCodingAgentTaskStore(directory).write({
    taskId: "task_interrupted",
    subagentId: "subagent-interrupted",
    type: "claude-code",
    agentId: `claude_${SESSION_ID}`,
    nativeSessionId: SESSION_ID,
    cwd: "/root/workspace/repo",
    description: "Finish the PR",
    parentAgentId: "agent-restart",
    parentConversationId: "conv-restart",
    actingUserId: "human-restart",
    startedAt: "2026-10-02T17:45:00.000Z",
    hostPid: 2 ** 22 + 54_321,
  });

  const listener = createRuntime();
  setActiveRuntime(listener);
  let turn: IncomingMessage | undefined;
  installProcessEventRouting({
    runtime: listener,
    processTransport: new LocalListenerTransport(),
    opts: {
      connectionId: "restart-connection",
      wsUrl: "ws://test",
      deviceId: "device-restart",
      connectionName: "test",
      onConnected() {},
      onDisconnected() {},
      onError() {},
    },
    processQueuedTurn: async (incoming) => {
      if (
        incoming.agentId === "agent-restart" &&
        incoming.conversationId === "conv-restart"
      ) {
        turn = incoming;
      }
    },
  });

  try {
    const deadline = Date.now() + 5_000;
    while (!turn && Date.now() < deadline) await Bun.sleep(10);
    if (!turn) throw new Error("No interruption turn arrived");

    expect(turn).toMatchObject({
      agentId: "agent-restart",
      conversationId: "conv-restart",
      actingUserId: "human-restart",
    });
    const serialized = JSON.stringify(turn.messages);
    expect(serialized).toContain("<task-id>task_interrupted</task-id>");
    expect(serialized).toContain("interrupted by a runtime restart");
    expect(serialized).toContain(`claude_${SESSION_ID}`);
    expect(createExternalCodingAgentTaskStore(directory).list()).toEqual([]);
  } finally {
    clearProcessServices(listener);
    clearPendingMessages();
    setActiveRuntime(null);
  }
});
