import type WebSocket from "ws";
import { getBackend } from "@/backend";
import type {
  AgentCreateCommand,
  AgentListCommand,
  AgentRetrieveCommand,
  ConversationCreateCommand,
  ConversationListCommand,
  ConversationRetrieveCommand,
} from "@/types/protocol_v2";
import {
  isAgentCreateCommand,
  isAgentListCommand,
  isAgentRetrieveCommand,
  isConversationCreateCommand,
  isConversationListCommand,
  isConversationRetrieveCommand,
} from "@/websocket/listener/protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type AgentConversationManagementCommand =
  | AgentListCommand
  | AgentRetrieveCommand
  | AgentCreateCommand
  | ConversationListCommand
  | ConversationRetrieveCommand
  | ConversationCreateCommand;

type AgentConversationManagementCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getPageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const candidate = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof candidate.getPaginatedItems === "function") {
      return candidate.getPaginatedItems();
    }
    if (Array.isArray(candidate.items)) {
      return candidate.items;
    }
  }
  return [];
}

export async function handleAgentConversationManagementCommand(
  parsed: AgentConversationManagementCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  const backend = getBackend();

  if (parsed.type === "agent_list") {
    try {
      const page = await backend.listAgents(parsed.query);
      safeSocketSend(
        socket,
        {
          type: "agent_list_response",
          request_id: parsed.request_id,
          success: true,
          agents: getPageItems(page),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_list_response",
          request_id: parsed.request_id,
          success: false,
          agents: [],
          error: getErrorMessage(error, "Failed to list agents"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "agent_retrieve") {
    try {
      const agent = await backend.retrieveAgent(parsed.agent_id);
      safeSocketSend(
        socket,
        {
          type: "agent_retrieve_response",
          request_id: parsed.request_id,
          success: true,
          agent,
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_retrieve_response",
          request_id: parsed.request_id,
          success: false,
          agent: null,
          error: getErrorMessage(error, "Failed to retrieve agent"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "agent_create") {
    try {
      const agent = await backend.createAgent(parsed.body);
      safeSocketSend(
        socket,
        {
          type: "agent_create_response",
          request_id: parsed.request_id,
          success: true,
          agent,
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_create_response",
          request_id: parsed.request_id,
          success: false,
          agent: null,
          error: getErrorMessage(error, "Failed to create agent"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_list") {
    try {
      const page = await backend.listConversations(parsed.query);
      safeSocketSend(
        socket,
        {
          type: "conversation_list_response",
          request_id: parsed.request_id,
          success: true,
          conversations: getPageItems(page),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_list_response",
          request_id: parsed.request_id,
          success: false,
          conversations: [],
          error: getErrorMessage(error, "Failed to list conversations"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_retrieve") {
    try {
      const conversation = await backend.retrieveConversation(
        parsed.conversation_id,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_retrieve_response",
          request_id: parsed.request_id,
          success: true,
          conversation,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_retrieve_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to retrieve conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_create") {
    try {
      const conversation = await backend.createConversation(parsed.body);
      safeSocketSend(
        socket,
        {
          type: "conversation_create_response",
          request_id: parsed.request_id,
          success: true,
          conversation,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_create_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to create conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  return false;
}

export function handleAgentConversationManagementProtocolCommand(
  parsed: unknown,
  context: AgentConversationManagementCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;

  if (
    isAgentListCommand(parsed) ||
    isAgentRetrieveCommand(parsed) ||
    isAgentCreateCommand(parsed) ||
    isConversationListCommand(parsed) ||
    isConversationRetrieveCommand(parsed) ||
    isConversationCreateCommand(parsed)
  ) {
    runDetachedListenerTask(
      "agent_conversation_management_command",
      async () => {
        await handleAgentConversationManagementCommand(
          parsed,
          socket,
          safeSocketSend,
        );
      },
    );
    return true;
  }

  return false;
}
