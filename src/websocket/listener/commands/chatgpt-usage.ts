import type WebSocket from "ws";
import { readChatGPTUsage } from "@/providers/chatgpt-usage-service";
import type {
  ChatGPTUsageReadCommand,
  ChatGPTUsageReadResponseMessage,
} from "@/types/protocol_v2";
import { isChatGPTUsageReadCommand } from "@/websocket/listener/protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

type ChatGPTUsageCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export async function buildChatGPTUsageReadResponse(
  command: ChatGPTUsageReadCommand,
): Promise<ChatGPTUsageReadResponseMessage> {
  const result = await readChatGPTUsage({
    target: command.target,
    ...(command.provider_name ? { providerName: command.provider_name } : {}),
    forceRefresh: command.force_refresh === true,
  });

  if (!result.success) {
    return {
      type: "chatgpt_usage_read_response",
      request_id: command.request_id,
      success: false,
      target: command.target,
      error: result.error,
    };
  }

  return {
    type: "chatgpt_usage_read_response",
    request_id: command.request_id,
    success: true,
    target: command.target,
    usage: result.usage,
  };
}

export function handleChatGPTUsageCommand(
  parsed: unknown,
  context: ChatGPTUsageCommandContext,
): boolean {
  if (!isChatGPTUsageReadCommand(parsed)) return false;

  const { socket, safeSocketSend, runDetachedListenerTask } = context;
  runDetachedListenerTask("chatgpt_usage_read", async () => {
    try {
      const response = await buildChatGPTUsageReadResponse(parsed);
      safeSocketSend(
        socket,
        response,
        "listener_chatgpt_usage_read_send_failed",
        "listener_chatgpt_usage_read",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "chatgpt_usage_read_response",
          request_id: parsed.request_id,
          success: false,
          target: parsed.target,
          error: {
            code: "network_error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to read ChatGPT usage.",
          },
        },
        "listener_chatgpt_usage_read_send_failed",
        "listener_chatgpt_usage_read",
      );
    }
  });
  return true;
}
