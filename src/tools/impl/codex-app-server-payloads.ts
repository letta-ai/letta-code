import type { SubagentResult } from "@/agent/subagents";
import {
  type ExternalToolCall,
  formatExternalToolCallArgs,
} from "./external-tool-call";

// Pure readers for Codex app-server notification payloads: turn results,
// capacity errors, and tool-like thread items.

/** Delays before the second and third attempts of a turn rejected for capacity. */
export const CAPACITY_RETRY_DELAYS_MS = [1_000, 2_000] as const;

export const CODEX_CAPACITY_ERROR =
  "Codex is out of capacity for this session; start a new codex session or use claude-code";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  return typeof record?.[key] === "string"
    ? (record[key] as string)
    : undefined;
}

/**
 * Codex reports an upstream HTTP status in `codexErrorInfo` when it has one;
 * older builds only include it in the message ("unexpected status 409 Conflict").
 */
export function isCapacityError(error: Record<string, unknown>): boolean {
  const info = asRecord(error.codexErrorInfo);
  if (
    info &&
    Object.values(info).some(
      (detail) => asRecord(detail)?.httpStatusCode === 409,
    )
  ) {
    return true;
  }
  return /\b409 Conflict\b/i.test(readString(error, "message") ?? "");
}

export function turnFailureMessage(
  turnError: Record<string, unknown> | undefined,
  notifications: Array<Record<string, unknown>>,
): string | undefined {
  const messages = [turnError, ...notifications]
    .map((error) => readString(error, "message")?.trim())
    .filter((message): message is string => Boolean(message));
  return messages.length ? [...new Set(messages)].join("; ") : undefined;
}

export function turnReport(params: Record<string, unknown>): string {
  const turn = asRecord(params.turn);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = asRecord(items[index]);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

/** Map a tool-like app-server ThreadItem to a display tool call. */
export function describeCodexToolItem(
  item: Record<string, unknown> | undefined,
): ExternalToolCall | undefined {
  const id = readString(item, "id");
  if (!item || !id) return undefined;
  const call = (name: string, args: unknown) => ({
    id,
    name,
    args: formatExternalToolCallArgs(args),
  });
  switch (item.type) {
    case "commandExecution":
      return call("Bash", { command: item.command });
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return call("Edit", {
        files: changes.map((change) => readString(change, "path")),
      });
    }
    case "mcpToolCall":
      return call(
        `${readString(item, "server") ?? "mcp"}/${readString(item, "tool") ?? "tool"}`,
        item.arguments,
      );
    case "dynamicToolCall":
      return call(readString(item, "tool") ?? "tool", item.arguments);
    case "webSearch": {
      // The query is often filled in only when the search completes.
      const query = readString(item, "query");
      return query ? call("WebSearch", { query }) : undefined;
    }
    default:
      return undefined;
  }
}

export const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
]);

export function capacityResult(result: SubagentResult): SubagentResult {
  return {
    ...result,
    error: `${CODEX_CAPACITY_ERROR}. Last error: ${result.error ?? "unknown"}`,
  };
}
