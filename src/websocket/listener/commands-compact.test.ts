import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { __listenClientTestUtils } from "@/websocket/listener/client";
import { handleExecuteCommand } from "@/websocket/listener/commands";

class CompactTestSocket {
  readonly sentPayloads: string[] = [];
  readonly readyState = 1;

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

afterEach(() => {
  __testSetBackend(null);
});

describe("listener compact command reminders", () => {
  test("successful manual compaction re-arms one-shot context reminders", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "listener-compact-"));
    try {
      class CompactBackend extends LocalBackend {
        override async compactConversationMessages(
          ..._args: Parameters<LocalBackend["compactConversationMessages"]>
        ): ReturnType<LocalBackend["compactConversationMessages"]> {
          return {
            num_messages_before: 7,
            num_messages_after: 2,
            summary: "compacted summary",
          } as Awaited<ReturnType<LocalBackend["compactConversationMessages"]>>;
        }
      }

      const backend = new CompactBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Compact Reminder Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        agent.id,
        "default",
      );
      runtime.reminderState.hasSentAgentInfo = true;
      runtime.reminderState.hasSentSessionContext = true;
      runtime.reminderState.hasSentSecretsInfo = true;
      const socket = new CompactTestSocket();

      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: "compact",
          request_id: "compact-reminders-1",
          runtime: { agent_id: agent.id, conversation_id: "default" },
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );

      expect(runtime.reminderState.hasSentAgentInfo).toBe(false);
      expect(runtime.reminderState.hasSentSessionContext).toBe(false);
      expect(runtime.reminderState.pendingSessionContextReason).toBe(
        "post_compaction",
      );
      expect(runtime.reminderState.hasSentSecretsInfo).toBe(false);
      expect(socket.sentPayloads.join("\n")).toContain(
        "Compaction completed. Message buffer length reduced from 7 to 2.",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
