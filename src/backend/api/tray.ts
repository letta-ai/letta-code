import { type ApiRequestMethod, apiRequest } from "./request";

export interface TrayMarkdownletPayloadV1 {
  version: 1;
  type: "markdownlet";
  title: string;
  markdown: string;
}

export type TrayPayload = TrayMarkdownletPayloadV1;

export interface TrayItem {
  id: string;
  agent_id: string;
  conversation_id: string;
  payload: TrayPayload;
  created_at: string;
  updated_at: string;
}

type TrayApiRequest = <T>(
  method: ApiRequestMethod,
  path: string,
  body?: Record<string, unknown>,
) => Promise<T>;

function trayPath(agentId: string, conversationId: string): string {
  return `/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/tray`;
}

export async function listTrayItems(
  agentId: string,
  conversationId: string,
  request: TrayApiRequest = apiRequest,
): Promise<TrayItem[]> {
  const response = await request<{ items: TrayItem[] }>(
    "GET",
    trayPath(agentId, conversationId),
  );
  return response.items;
}

export async function createTrayItem(
  agentId: string,
  conversationId: string,
  payload: TrayPayload,
  request: TrayApiRequest = apiRequest,
): Promise<TrayItem> {
  return request("POST", trayPath(agentId, conversationId), { payload });
}

export async function updateTrayItem(
  agentId: string,
  conversationId: string,
  trayItemId: string,
  payload: TrayPayload,
  request: TrayApiRequest = apiRequest,
): Promise<TrayItem> {
  return request(
    "PATCH",
    `${trayPath(agentId, conversationId)}/${encodeURIComponent(trayItemId)}`,
    { payload },
  );
}

export async function deleteTrayItem(
  agentId: string,
  conversationId: string,
  trayItemId: string,
  request: TrayApiRequest = apiRequest,
): Promise<void> {
  await request(
    "DELETE",
    `${trayPath(agentId, conversationId)}/${encodeURIComponent(trayItemId)}`,
  );
}
