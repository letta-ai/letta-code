import { apiRequest } from "@/backend/api/request";

interface AgentRepositoryResponse {
  repositories: Array<{
    id: string;
    name: string;
    is_primary: boolean;
    permissions: string;
  }>;
}

export interface AttachedAgentRepository {
  id: string;
  name: string;
  permissions?: string;
}

export async function listAttachedAgentRepositories(
  agentId: string,
): Promise<AttachedAgentRepository[]> {
  const response = await apiRequest<AgentRepositoryResponse>(
    "GET",
    `/v1/agents/${encodeURIComponent(agentId)}/repositories`,
  );
  return response.repositories
    .filter(
      (repository) => !repository.is_primary && repository.name !== "memory",
    )
    .map((repository) => ({
      id: repository.id,
      name: repository.name,
      permissions: repository.permissions,
    }));
}
