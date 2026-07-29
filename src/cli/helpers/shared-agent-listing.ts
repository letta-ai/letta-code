import { apiRequest } from "@/backend/api/request";

export interface SharedAgentCreatorDetails {
  id: string;
  name?: string | null;
  email?: string | null;
  image_url?: string | null;
  is_api_created?: boolean;
}

export interface SharedAgentSummary {
  id: string;
  name?: string | null;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_run_completion?: string | null;
  created_by_id?: string | null;
  creator?: SharedAgentCreatorDetails | null;
}

export type SharedAgentOrderBy =
  | "created_at"
  | "updated_at"
  | "last_run_completion";

export interface ListSharedAgentsParams {
  limit?: number;
  after?: string | null;
  queryText?: string | null;
  order?: "asc" | "desc";
  orderBy?: SharedAgentOrderBy;
}

export interface ListSharedAgentsResponse {
  agents: SharedAgentSummary[];
  nextCursor?: string | null;
}

function buildListSharedAgentsQuery(
  params: ListSharedAgentsParams,
): Record<string, string | number | boolean | null | undefined> {
  return {
    limit: params.limit,
    after: params.after,
    queryText: params.queryText,
    order: params.order,
    orderBy: params.orderBy,
  };
}

export async function listSharedAgentsForCurrentUser(
  params: ListSharedAgentsParams,
): Promise<ListSharedAgentsResponse> {
  return apiRequest<ListSharedAgentsResponse>(
    "GET",
    "/v1/shared-agents",
    undefined,
    { query: buildListSharedAgentsQuery(params) },
  );
}
