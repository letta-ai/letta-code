import type { UnifiedMcpSearchMode } from "@/backend/api/unified-mcp";
import type { McpToolDefinition } from "@/mcp-client";
import { McpCliError } from "./mcp-io";

const DEFAULT_SEARCH_LIMIT = 5;

export interface McpSearchResult {
  tool: Record<string, unknown> | null;
  score: number;
}

export interface McpSearchRequest {
  query: string;
  searchMode: UnifiedMcpSearchMode;
  limit: number;
}

export function mergeMcpSearchResults(
  serverResults: McpSearchResult[],
  localResults: McpSearchResult[],
  limit: number,
): McpSearchResult[] {
  return [
    ...localResults.map((result, index) => ({
      result,
      index,
      sourcePriority: 0,
      fusedScore: result.score / (index + 1),
    })),
    ...serverResults.map((result, index) => ({
      result,
      index,
      sourcePriority: 1,
      fusedScore: 1 / (index + 1),
    })),
  ]
    .sort((left, right) => {
      const byScore = right.fusedScore - left.fusedScore;
      if (byScore !== 0) return byScore;
      if (left.sourcePriority !== right.sourcePriority) {
        return left.sourcePriority - right.sourcePriority;
      }
      const leftName = left.result.tool?.name;
      const rightName = right.result.tool?.name;
      const byName = (
        typeof leftName === "string" ? leftName : ""
      ).localeCompare(typeof rightName === "string" ? rightName : "");
      return byName || left.index - right.index;
    })
    .slice(0, limit)
    .map(({ result, fusedScore }) => ({
      ...result,
      score: Number(fusedScore.toFixed(6)),
    }));
}

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

function terms(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function containsTerm(candidates: Set<string>, query: string): boolean {
  if (candidates.has(query)) return true;
  if (query.length < 3) return false;
  return [...candidates].some(
    (candidate) =>
      candidate.length >= 3 &&
      (candidate.startsWith(query) || query.startsWith(candidate)),
  );
}

function localToolJsonSchema(tool: McpToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.inputSchema,
  };
}

function scoreLocalTool(tool: McpToolDefinition, query: string): number {
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return 0;
  const fields = [
    { terms: new Set(terms(tool.name)), weight: 4 },
    { terms: new Set(terms(tool.title ?? "")), weight: 3 },
    { terms: new Set(terms(tool.description ?? "")), weight: 2 },
    { terms: new Set(terms(JSON.stringify(tool.inputSchema))), weight: 1 },
  ];
  let points = 0;
  for (const queryTerm of queryTerms) {
    const field = fields.find((candidate) =>
      containsTerm(candidate.terms, queryTerm),
    );
    points += field?.weight ?? 0;
  }
  return Number((points / (queryTerms.length * 4)).toFixed(6));
}

export function searchLocalMcpTools(params: {
  tools: McpToolDefinition[];
  query: string;
  searchMode: UnifiedMcpSearchMode;
  limit: number;
}): McpSearchResult[] {
  if (params.searchMode === "vector") {
    throw new McpCliError(
      "unsupported_search_mode",
      "Vector MCP tool search is unavailable with the local backend",
      "Use --mode fts or --mode hybrid.",
    );
  }

  // Local agents have no MCP embedding index. Hybrid therefore uses the same
  // deterministic lexical ranking as fts instead of making a network request.
  return params.tools
    .map((tool) => ({
      tool,
      score: scoreLocalTool(tool, params.query),
    }))
    .filter((result) => result.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.tool.name.localeCompare(right.tool.name),
    )
    .slice(0, params.limit)
    .map((result) => ({
      tool: localToolJsonSchema(result.tool),
      score: result.score,
    }));
}

export async function runMcpSearch(params: {
  searchTools: (request: McpSearchRequest) => Promise<McpSearchResult[]>;
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
  const results = await params.searchTools({ query, searchMode, limit });
  params.stdout(
    JSON.stringify(
      results.map((result, index) => ({
        tool: result.tool,
        rank: index + 1,
        score: result.score,
      })),
      null,
      2,
    ),
  );
  return 0;
}
