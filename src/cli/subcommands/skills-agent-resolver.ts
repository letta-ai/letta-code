import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Backend } from "@/backend/backend";

const AGENT_LOOKUP_PAGE_SIZE = 100;

type AgentLookupBackend = Pick<Backend, "listAgents" | "retrieveAgent">;

interface AgentPage {
  items?: unknown;
  getPaginatedItems?: () => AgentState[];
  hasNextPage?: () => boolean;
  getNextPage?: () => Promise<unknown>;
}

function pageItems(page: unknown): AgentState[] {
  if (Array.isArray(page)) return page as AgentState[];
  const typedPage = page as AgentPage;
  if (typeof typedPage.getPaginatedItems === "function") {
    return typedPage.getPaginatedItems();
  }
  return Array.isArray(typedPage.items)
    ? (typedPage.items as AgentState[])
    : [];
}

export async function resolveSkillsAgentById(
  agentId: string,
  backend: AgentLookupBackend,
): Promise<string> {
  await backend.retrieveAgent(agentId);
  return agentId;
}

export async function resolveSkillsAgentByName(
  name: string,
  backend: AgentLookupBackend,
): Promise<string> {
  const normalizedName = name.toLowerCase();
  const matches: AgentState[] = [];
  const query = { query_text: name, limit: AGENT_LOOKUP_PAGE_SIZE };
  let page: unknown = await backend.listAgents(query);

  while (true) {
    const items = pageItems(page);
    for (const agent of items) {
      if (agent.name?.toLowerCase() === normalizedName) matches.push(agent);
      if (matches.length > 1) {
        throw new Error(
          `Multiple agents found with name "${name}". Pass --agent with an agent id instead.`,
        );
      }
    }

    const paginatedPage = page as AgentPage;
    if (
      typeof paginatedPage.hasNextPage === "function" &&
      paginatedPage.hasNextPage()
    ) {
      if (typeof paginatedPage.getNextPage !== "function") break;
      page = await paginatedPage.getNextPage();
      continue;
    }

    if (typeof paginatedPage.hasNextPage === "function") break;
    if (items.length < AGENT_LOOKUP_PAGE_SIZE) break;
    const after = items.at(-1)?.id;
    if (!after) break;
    page = await backend.listAgents({ ...query, after });
  }

  if (matches.length === 0) {
    throw new Error(`No agent found with name "${name}".`);
  }
  const id = matches[0]?.id;
  if (!id) throw new Error(`Agent "${name}" did not include an id.`);
  return id;
}
