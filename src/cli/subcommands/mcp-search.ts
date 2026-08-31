import {
  searchUnifiedMcpTools,
  type UnifiedMcpClient,
  type UnifiedMcpSearchMode,
} from "@/backend/api/unified-mcp";
import { McpCliError } from "./mcp-io";

const DEFAULT_SEARCH_LIMIT = 5;

function parseSearchMode(value: string | undefined): UnifiedMcpSearchMode {
  if (value === undefined) return "hybrid";
  if (value === "vector" || value === "fts" || value === "hybrid") {
    return value;
  }
  throw new McpCliError(
    "invalid_arguments",
    `Invalid search mode '${value}'. Use vector, fts, or hybrid.`,
  );
}

function parseSearchLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new McpCliError(
      "invalid_arguments",
      "--limit must be an integer from 1 to 100",
    );
  }
  return limit;
}

export async function runMcpSearch(params: {
  getClient: () => Promise<Pick<UnifiedMcpClient, "post">>;
  agentId: string;
  query: string | undefined;
  mode: string | undefined;
  limit: string | undefined;
  stdout: (message: string) => void;
}): Promise<number> {
  const query = params.query?.trim();
  if (!query) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp search <query>",
    );
  }
  const searchMode = parseSearchMode(params.mode);
  const limit = parseSearchLimit(params.limit);
  const client = await params.getClient();
  const results = await searchUnifiedMcpTools({
    client,
    agentId: params.agentId,
    query,
    searchMode,
    limit,
  });
  params.stdout(
    JSON.stringify(
      results.map((result, index) => ({
        tool: result.jsonSchema,
        rank: index + 1,
        score: result.score,
      })),
      null,
      2,
    ),
  );
  return 0;
}
