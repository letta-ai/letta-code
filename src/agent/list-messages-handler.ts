import { randomUUID } from "node:crypto";
import type { Backend, ConversationMessageListBody } from "@/backend";
import type {
  ControlResponse,
  ListMessagesControlRequest,
  ListMessagesResponsePayload,
} from "@/types/protocol";
import { resolveListMessagesRoute } from "./list-messages-routing";

export type ListMessagesHandlerBackend = Pick<
  Backend,
  "listConversationMessages"
>;

export interface HandleListMessagesParams {
  listReq: ListMessagesControlRequest;
  sessionConversationId: string;
  sessionAgentId: string;
  sessionId: string;
  requestId: string;
  backend: ListMessagesHandlerBackend;
}

export async function handleListMessages(
  params: HandleListMessagesParams,
): Promise<ControlResponse> {
  const {
    listReq,
    sessionConversationId,
    sessionAgentId,
    sessionId,
    requestId,
    backend,
  } = params;

  const limit = listReq.limit ?? 50;
  const order = listReq.order ?? "desc";
  const cursorOpts = {
    ...(listReq.before ? { before: listReq.before } : {}),
    ...(listReq.after ? { after: listReq.after } : {}),
  };

  try {
    const route = resolveListMessagesRoute(
      listReq,
      sessionConversationId,
      sessionAgentId,
    );

    const page = await backend.listConversationMessages(route.conversationId, {
      limit,
      order,
      ...(route.agentId ? { agent_id: route.agentId } : {}),
      ...cursorOpts,
    } as ConversationMessageListBody);
    const items = page.getPaginatedItems();

    const hasMore = items.length >= limit;
    const oldestId =
      items.length > 0
        ? (items[items.length - 1] as { id?: string })?.id
        : undefined;

    const payload: ListMessagesResponsePayload = {
      messages: items,
      next_before: oldestId ?? null,
      has_more: hasMore,
    };

    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: payload as unknown as Record<string, unknown>,
      },
      session_id: sessionId,
      uuid: randomUUID(),
    };
  } catch (err) {
    return {
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: err instanceof Error ? err.message : "list_messages failed",
      },
      session_id: sessionId,
      uuid: randomUUID(),
    };
  }
}
