import { type ApiRequestMethod, apiRequest } from "./request";

export interface CloudReflectionConfig {
  agent_id: string;
  enabled: boolean;
  min_turn_count: number;
  cutover?: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpdateCloudReflectionConfigInput {
  enabled: boolean;
  min_turn_count: number;
}

export interface UpdateCloudReflectionConversationProgressInput {
  reflected_through_message_id: string;
}

type ReflectionApiRequest = <T>(
  method: ApiRequestMethod,
  path: string,
  body?: Record<string, unknown>,
) => Promise<T>;

function agentPath(agentId: string): string {
  return `/v1/agents/${encodeURIComponent(agentId)}`;
}

export async function retrieveCloudReflectionConfig(
  agentId: string,
  request: ReflectionApiRequest = apiRequest,
): Promise<CloudReflectionConfig> {
  return request("GET", `${agentPath(agentId)}/reflection`);
}

export async function updateCloudReflectionConfig(
  agentId: string,
  input: UpdateCloudReflectionConfigInput,
  request: ReflectionApiRequest = apiRequest,
): Promise<void> {
  await request("PATCH", `${agentPath(agentId)}/reflection`, { ...input });
}

export async function updateCloudReflectionConversationProgress(
  agentId: string,
  conversationId: string,
  input: UpdateCloudReflectionConversationProgressInput,
  request: ReflectionApiRequest = apiRequest,
): Promise<void> {
  await request(
    "PATCH",
    `${agentPath(agentId)}/conversations/${encodeURIComponent(conversationId)}/reflection`,
    { ...input },
  );
}
