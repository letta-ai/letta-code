/**
 * Extracted handler for the bootstrap_session_state control request.
 *
 * Returns a single ControlResponse containing:
 *  - resolved session metadata (agent_id, conversation_id, model, tools, memfs_enabled)
 *  - initial history page (messages, next_before, has_more)
 *  - pending approval flag
 *  - optional wall-clock timings
 *
 * Accepting minimal client/context interfaces keeps the handler fully testable
 * without a real network or subprocess.
 */

import { randomUUID } from "node:crypto";
import type {
  BootstrapSessionStatePayload,
  BootstrapSessionStateRequest,
  ControlResponse,
} from "../types/protocol";
import { resolveListMessagesRoute } from "./listMessagesRouting";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal interfaces — only what the handler needs
// ─────────────────────────────────────────────────────────────────────────────

export interface BootstrapMessagesPage {
  /** conversations.messages.list() returns a paginated resource */
  getPaginatedItems(): unknown[];
}

export interface BootstrapAgentsPage {
  items: unknown[];
}

export interface BootstrapHandlerClient {
  conversations: {
    messages: {
      list(
        conversationId: string,
        opts: {
          limit: number;
          order: "asc" | "desc";
          before?: string;
          after?: string;
        },
      ): Promise<BootstrapMessagesPage>;
    };
  };
  agents: {
    messages: {
      list(
        agentId: string,
        opts: {
          limit: number;
          order: "asc" | "desc";
          before?: string;
          after?: string;
          conversation_id?: "default";
        },
      ): Promise<BootstrapAgentsPage>;
    };
  };
}

export interface BootstrapHandlerSessionContext {
  agentId: string;
  conversationId: string;
  model: string | undefined;
  tools: string[];
  memfsEnabled: boolean;
  sessionId: string;
}

export interface HandleBootstrapParams {
  bootstrapReq: BootstrapSessionStateRequest;
  sessionContext: BootstrapHandlerSessionContext;
  requestId: string;
  client: BootstrapHandlerClient;
  /** Optional: flag indicating a pending approval is waiting. */
  hasPendingApproval?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a bootstrap_session_state control request and return the ControlResponse.
 *
 * Caller is responsible for serialising + writing to stdout:
 *   console.log(JSON.stringify(await handleBootstrapSessionState(params)));
 */
export async function handleBootstrapSessionState(
  params: HandleBootstrapParams,
): Promise<ControlResponse> {
  const {
    bootstrapReq,
    sessionContext,
    requestId,
    client,
    hasPendingApproval,
  } = params;

  const bootstrapStart = Date.now();

  const limit = bootstrapReq.limit ?? 50;
  const order = bootstrapReq.order ?? "desc";

  try {
    // Reuse the same routing logic as list_messages for consistency
    const route = resolveListMessagesRoute(
      { conversation_id: undefined, agent_id: sessionContext.agentId },
      sessionContext.conversationId,
      sessionContext.agentId,
    );

    const listStart = Date.now();
    let items: unknown[];

    if (route.kind === "conversations") {
      const page = await client.conversations.messages.list(
        route.conversationId,
        { limit, order },
      );
      items = page.getPaginatedItems();
    } else {
      const page = await client.agents.messages.list(route.agentId, {
        limit,
        order,
        conversation_id: "default",
      });
      items = page.items;
    }
    const listEnd = Date.now();

    const hasMore = items.length >= limit;
    // When order=desc, newest first; oldest item is at the end of the array.
    const oldestId =
      items.length > 0
        ? (items[items.length - 1] as { id?: string })?.id
        : undefined;

    const bootstrapEnd = Date.now();

    const payload: BootstrapSessionStatePayload = {
      agent_id: sessionContext.agentId,
      conversation_id: sessionContext.conversationId,
      model: sessionContext.model,
      tools: sessionContext.tools,
      memfs_enabled: sessionContext.memfsEnabled,
      messages: items,
      next_before: oldestId ?? null,
      has_more: hasMore,
      has_pending_approval: hasPendingApproval ?? false,
      timings: {
        resolve_ms: listStart - bootstrapStart,
        list_messages_ms: listEnd - listStart,
        total_ms: bootstrapEnd - bootstrapStart,
      },
    };

    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: payload as unknown as Record<string, unknown>,
      },
      session_id: sessionContext.sessionId,
      uuid: randomUUID(),
    };
  } catch (err) {
    return {
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error:
          err instanceof Error ? err.message : "bootstrap_session_state failed",
      },
      session_id: sessionContext.sessionId,
      uuid: randomUUID(),
    };
  }
}
