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

describe("runtime_start conversation tags", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  test("adds requested tags without replacing existing conversation tags", async () => {
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
        summary: "Channel conversation",
      });
      await backend.updateConversation(conversation.id, {
        tags: ["existing"],
      } as ConversationUpdateBody);
      const responses: RuntimeStartResponseMessage[] = [];

      await handleRuntimeStartCommand(
        {
          type: "runtime_start",
          request_id: "runtime-channel-tags",
          agent_id: agent.id,
          conversation_id: conversation.id,
          ensure_conversation_tags: ["channel:slack", "existing"],
          recover_approvals: false,
        },
        {
          socket: {} as WebSocket,
          connectionId: "test-connection",
          runtime: createRuntime(),
          safeSocketSend: (_socket, message) => {
            const response = message as RuntimeStartResponseMessage;
            if (response.type === "runtime_start_response") {
              responses.push(response);
            }
            return true;
          },
          runDetachedListenerTask: () => {},
          getOrCreateScopedRuntime,
          replaySyncStateForRuntime: async () => {},
        },
      );

      const updated = await backend.retrieveConversation(conversation.id);
      expect(Reflect.get(updated, "tags")).toEqual([
        "existing",
        "channel:slack",
      ]);
      const responseConversation = responses[0]?.conversation;
      expect(
        responseConversation
          ? Reflect.get(responseConversation, "tags")
          : undefined,
      ).toEqual(["existing", "channel:slack"]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
