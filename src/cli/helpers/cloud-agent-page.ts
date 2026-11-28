export const FETCH_PAGE_SIZE = 20;
export async function fetchCloudAgentPage(
  afterCursor?: string | null,
  query?: string,
) {
  const { getClient } = await import("@/backend/api/client");
  const client = await getClient();

  const agentList = await client.agents.list({
    limit: FETCH_PAGE_SIZE,
    include: ["agent.blocks"],
    order: "desc",
    order_by: "last_run_completion",
    ...(afterCursor && { after: afterCursor }),
    ...(query && { query_text: query }),
  });

  const cursor =
    agentList.items.length === FETCH_PAGE_SIZE
      ? (agentList.items[agentList.items.length - 1]?.id ?? null)
      : null;

  return { agents: agentList.items, nextCursor: cursor };
}
