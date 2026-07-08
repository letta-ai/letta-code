import type WebSocket from "ws";
import { actingUserRequestOptions } from "@/agent/acting-user";
import { getBackend } from "@/backend";
import type {
  AgentCreateCommand,
  AgentDeleteCommand,
  AgentListCommand,
  AgentRetrieveCommand,
  AgentUpdateCommand,
  ConversationCompactCommand,
  ConversationCreateCommand,
  ConversationForkCommand,
  ConversationListCommand,
  ConversationMessagesListCommand,
  ConversationRecompileCommand,
  ConversationRetrieveCommand,
  ConversationUpdateCommand,
} from "@/types/protocol_v2";
import {
  isAgentCreateCommand,
  isAgentDeleteCommand,
  isAgentListCommand,
  isAgentRetrieveCommand,
  isAgentUpdateCommand,
  isConversationCompactCommand,
  isConversationCreateCommand,
  isConversationForkCommand,
  isConversationListCommand,
  isConversationMessagesListCommand,
  isConversationRecompileCommand,
  isConversationRetrieveCommand,
  isConversationUpdateCommand,
} from "@/websocket/listener/protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type AgentConversationManagementCommand =
  | AgentListCommand
  | AgentRetrieveCommand
  | AgentCreateCommand
  | AgentUpdateCommand
  | AgentDeleteCommand
  | ConversationListCommand
  | ConversationRetrieveCommand
  | ConversationCreateCommand
  | ConversationUpdateCommand
  | ConversationRecompileCommand
  | ConversationForkCommand
  | ConversationMessagesListCommand
  | ConversationCompactCommand;

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
      const { prepareRawCreateAgentBodyForMemfs, enableMemfsIfCloud } =
        await import("@/agent/memory-filesystem");
      const body = await prepareRawCreateAgentBodyForMemfs(parsed.body);
      const agent = await backend.createAgent(body);
      // Finish memfs setup (settings, repo clone, legacy tool detach) without
      // blocking the response. The tag is already stamped at creation, so
      // lazy sync paths can complete this even if the process dies here.
      void enableMemfsIfCloud(agent.id);
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

  if (parsed.type === "agent_update") {
    try {
      const agent = await backend.updateAgent(parsed.agent_id, parsed.body);
      safeSocketSend(
        socket,
        {
          type: "agent_update_response",
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
          type: "agent_update_response",
          request_id: parsed.request_id,
          success: false,
          agent: null,
          error: getErrorMessage(error, "Failed to update agent"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "agent_delete") {
    try {
      await backend.deleteAgent(parsed.agent_id);
      safeSocketSend(
        socket,
        {
          type: "agent_delete_response",
          request_id: parsed.request_id,
          success: true,
          agent_id: parsed.agent_id,
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_delete_response",
          request_id: parsed.request_id,
          success: false,
          agent_id: parsed.agent_id,
          error: getErrorMessage(error, "Failed to delete agent"),
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
      const conversation = await backend.createConversation(
        parsed.body,
        actingUserRequestOptions(parsed.acting_user_id),
      );
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

  if (parsed.type === "conversation_update") {
    try {
      const conversation = await backend.updateConversation(
        parsed.conversation_id,
        parsed.body,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_update_response",
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
          type: "conversation_update_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to update conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_recompile") {
    try {
      const result = await backend.recompileConversation(
        parsed.conversation_id,
        parsed.body,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_recompile_response",
          request_id: parsed.request_id,
          success: true,
          result,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_recompile_response",
          request_id: parsed.request_id,
          success: false,
          result: null,
          error: getErrorMessage(error, "Failed to recompile conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_fork") {
    try {
      const conversation = await backend.forkConversation(
        parsed.conversation_id,
        {
          ...(typeof parsed.body?.agent_id === "string"
            ? { agentId: parsed.body.agent_id }
            : {}),
          ...(typeof parsed.body?.hidden === "boolean"
            ? { hidden: parsed.body.hidden }
            : {}),
          ...(actingUserRequestOptions(parsed.acting_user_id) ?? {}),
        },
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_fork_response",
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
          type: "conversation_fork_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to fork conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_messages_list") {
    try {
      const page = await backend.listConversationMessages(
        parsed.conversation_id,
        parsed.query,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_messages_list_response",
          request_id: parsed.request_id,
          success: true,
          messages: getPageItems(page),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_messages_list_response",
          request_id: parsed.request_id,
          success: false,
          messages: [],
          error: getErrorMessage(error, "Failed to list conversation messages"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_compact") {
    try {
      const compaction = await backend.compactConversationMessages(
        parsed.conversation_id,
        parsed.body,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_compact_response",
          request_id: parsed.request_id,
          success: true,
          compaction,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_compact_response",
          request_id: parsed.request_id,
          success: false,
          compaction: null,
          error: getErrorMessage(error, "Failed to compact conversation"),
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
    isAgentUpdateCommand(parsed) ||
    isAgentDeleteCommand(parsed) ||
    isConversationListCommand(parsed) ||
    isConversationRetrieveCommand(parsed) ||
    isConversationCreateCommand(parsed) ||
    isConversationUpdateCommand(parsed) ||
    isConversationRecompileCommand(parsed) ||
    isConversationForkCommand(parsed) ||
    isConversationMessagesListCommand(parsed) ||
    isConversationCompactCommand(parsed)
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
