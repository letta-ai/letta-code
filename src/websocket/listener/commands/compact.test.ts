import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import type { ListenerTransport } from "@/websocket/listener/transport";
import { createChannelCompactHandler } from "./compact";

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

afterEach(() => {
  __testSetBackend(null);
});

describe("channel compact command handler", () => {
  test("runs manual compaction for the routed conversation", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "channel-compact-"));
    try {
      class CompactRecordingBackend extends LocalBackend {
        compactCalls: Parameters<
          LocalBackend["compactConversationMessages"]
        >[] = [];

        override async compactConversationMessages(
          ...args: Parameters<LocalBackend["compactConversationMessages"]>
        ): ReturnType<LocalBackend["compactConversationMessages"]> {
          this.compactCalls.push(args);
          return {
            num_messages_before: 7,
            num_messages_after: 2,
            summary: "compacted summary",
          } as Awaited<ReturnType<LocalBackend["compactConversationMessages"]>>;
        }
      }

      const backend = new CompactRecordingBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Compact Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const socket = new MockSocket();
      const handler = createChannelCompactHandler(
        listener,
        socket as unknown as ListenerTransport,
      );

      const result = await handler({
        channelId: "slack",
        runtime: { agent_id: agent.id, conversation_id: "default" },
        args: "sliding_window",
      });

      expect(result).toEqual({
        handled: true,
        text: "Compaction completed (mode: sliding_window). Message buffer length reduced from 7 to 2.\n\nSummary: compacted summary",
      });
      expect(backend.compactCalls).toHaveLength(1);
      expect(backend.compactCalls[0]?.[0]).toBe("default");
      expect(backend.compactCalls[0]?.[1]).toMatchObject({
        agent_id: agent.id,
        compaction_settings: {
          mode: "sliding_window",
        },
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
