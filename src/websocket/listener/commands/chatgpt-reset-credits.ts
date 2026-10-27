import type WebSocket from "ws";
import {
  consumeChatGPTRateLimitResetCredit,
  readChatGPTRateLimitResetCredits,
} from "@/providers/chatgpt-reset-credit-service";
import type {
  ChatGPTRateLimitResetCreditConsumeCommand,
  ChatGPTRateLimitResetCreditConsumeResponseMessage,
  ChatGPTRateLimitResetCreditsListCommand,
  ChatGPTRateLimitResetCreditsListResponseMessage,
} from "@/types/chatgpt-usage-protocol";
import {
  isChatGPTRateLimitResetCreditConsumeCommand,
  isChatGPTRateLimitResetCreditsListCommand,
} from "@/websocket/listener/chatgpt-usage-protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

type ChatGPTResetCreditsCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

type ChatGPTResetCreditsDependencies = {
  readCredits?: typeof readChatGPTRateLimitResetCredits;
  consumeCredit?: typeof consumeChatGPTRateLimitResetCredit;
};

export async function buildChatGPTResetCreditsListResponse(
  command: ChatGPTRateLimitResetCreditsListCommand,
  dependencies: ChatGPTResetCreditsDependencies = {},
): Promise<ChatGPTRateLimitResetCreditsListResponseMessage> {
  const result = await (
    dependencies.readCredits ?? readChatGPTRateLimitResetCredits
  )({
    target: command.target,
    ...(command.provider_name ? { providerName: command.provider_name } : {}),
    forceRefresh: command.force_refresh === true,
  });

  if (!result.success) {
    return {
      type: "chatgpt_rate_limit_reset_credits_list_response",
      request_id: command.request_id,
      success: false,
      target: command.target,
      error: result.error,
    };
  }

  return {
    type: "chatgpt_rate_limit_reset_credits_list_response",
    request_id: command.request_id,
    success: true,
    target: command.target,
    credits: result.credits,
  };
}

export async function buildChatGPTResetCreditConsumeResponse(
  command: ChatGPTRateLimitResetCreditConsumeCommand,
  dependencies: ChatGPTResetCreditsDependencies = {},
): Promise<ChatGPTRateLimitResetCreditConsumeResponseMessage> {
  const result = await (
    dependencies.consumeCredit ?? consumeChatGPTRateLimitResetCredit
  )({
    target: command.target,
    ...(command.provider_name ? { providerName: command.provider_name } : {}),
    idempotencyKey: command.idempotency_key,
    ...(command.reset_id ? { resetId: command.reset_id } : {}),
  });

  if (!result.success) {
    return {
      type: "chatgpt_rate_limit_reset_credit_consume_response",
      request_id: command.request_id,
      success: false,
      target: command.target,
      error: result.error,
    };
  }

  return {
    type: "chatgpt_rate_limit_reset_credit_consume_response",
    request_id: command.request_id,
    success: true,
    target: command.target,
    outcome: result.outcome,
    ...(result.refreshedUsage
      ? { refreshed_usage: result.refreshedUsage }
      : {}),
    ...(result.refreshedCredits
      ? { refreshed_credits: result.refreshedCredits }
      : {}),
    ...(result.refreshError ? { refresh_error: result.refreshError } : {}),
  };
}

function sendUnexpectedFailure(
  socket: WebSocket,
  command:
    | ChatGPTRateLimitResetCreditsListCommand
    | ChatGPTRateLimitResetCreditConsumeCommand,
  safeSocketSend: SafeSocketSend,
): void {
  const isList = command.type === "chatgpt_rate_limit_reset_credits_list";
  safeSocketSend(
    socket,
    {
      type: isList
        ? "chatgpt_rate_limit_reset_credits_list_response"
        : "chatgpt_rate_limit_reset_credit_consume_response",
      request_id: command.request_id,
      success: false,
      target: command.target,
      error: {
        code: "network_error",
        message: "Failed to process the ChatGPT reset-credit request.",
      },
    },
    "listener_chatgpt_reset_credits_send_failed",
    "listener_chatgpt_reset_credits",
  );
}

export function handleChatGPTResetCreditsCommand(
  parsed: unknown,
  context: ChatGPTResetCreditsCommandContext,
): boolean {
  if (isChatGPTRateLimitResetCreditsListCommand(parsed)) {
    const { socket, safeSocketSend, runDetachedListenerTask } = context;
    runDetachedListenerTask("chatgpt_reset_credits_list", async () => {
      try {
        safeSocketSend(
          socket,
          await buildChatGPTResetCreditsListResponse(parsed),
          "listener_chatgpt_reset_credits_send_failed",
          "listener_chatgpt_reset_credits_list",
        );
      } catch {
        sendUnexpectedFailure(socket, parsed, safeSocketSend);
      }
    });
    return true;
  }

  if (isChatGPTRateLimitResetCreditConsumeCommand(parsed)) {
    const { socket, safeSocketSend, runDetachedListenerTask } = context;
    runDetachedListenerTask("chatgpt_reset_credit_consume", async () => {
      try {
        safeSocketSend(
          socket,
          await buildChatGPTResetCreditConsumeResponse(parsed),
          "listener_chatgpt_reset_credits_send_failed",
          "listener_chatgpt_reset_credit_consume",
        );
      } catch {
        sendUnexpectedFailure(socket, parsed, safeSocketSend);
      }
    });
    return true;
  }

  return false;
}
