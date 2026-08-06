import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import {
  __testSetBackend,
  type AgentCreateBody,
  type ConversationUpdateBody,
} from "@/backend";
import { LocalBackend } from "@/backend/local";
import type { RuntimeStartResponseMessage } from "@/types/protocol_v2";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { handleRuntimeStartCommand } from "./runtime-start";

describe("runtime_start conversation source tags", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  test("source tags replace matching legacy prefixes", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "runtime-tags-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
        summary: "[Slack] Channel conversation",
      });
      await backend.updateConversation(conversation.id, {
        tags: ["existing"],
      } as ConversationUpdateBody);
      const responses: RuntimeStartResponseMessage[] = [];
      const context = {
        socket: {} as WebSocket,
        connectionId: "test-connection",
        runtime: createRuntime(),
        safeSocketSend: (_socket: WebSocket, message: unknown) => {
          const response = message as RuntimeStartResponseMessage;
          if (response.type === "runtime_start_response") {
            responses.push(response);
          }
          return true;
        },
        runDetachedListenerTask: () => {},
        getOrCreateScopedRuntime,
        replaySyncStateForRuntime: async () => {},
      };
      const startRuntime = (requestId: string) =>
        handleRuntimeStartCommand(
          {
            type: "runtime_start",
            request_id: requestId,
            agent_id: agent.id,
            conversation_id: conversation.id,
            conversation_source_tags: ["channel:slack"],
            recover_approvals: false,
          },
          context,
        );

      await startRuntime("runtime-channel-tags-1");

      let updated = await backend.retrieveConversation(conversation.id);
      expect(Reflect.get(updated, "tags")).toEqual([
        "existing",
        "channel:slack",
      ]);
      expect(updated.summary).toBe("Channel conversation");
      expect(responses[0]?.conversation?.summary).toBe("Channel conversation");
      expect(Reflect.get(responses[0]?.conversation ?? {}, "tags")).toEqual([
        "existing",
        "channel:slack",
      ]);

      await backend.updateConversation(conversation.id, {
        summary: "[Slack] Renamed conversation",
      });
      await startRuntime("runtime-channel-tags-2");
      updated = await backend.retrieveConversation(conversation.id);
      expect(updated.summary).toBe("Renamed conversation");

      await backend.updateConversation(conversation.id, {
        summary: "[Telegram] Mismatched conversation",
      });
      await startRuntime("runtime-channel-tags-3");
      updated = await backend.retrieveConversation(conversation.id);
      expect(updated.summary).toBe("[Telegram] Mismatched conversation");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
