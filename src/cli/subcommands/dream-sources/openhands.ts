import { readFile } from "node:fs/promises";
import type { ExternalTranscriptEntry } from "@/cli/helpers/reflection-transcript";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import type { SourceAdapter } from "./types";

/** Maximum characters kept for a tool result when converting external traces. */
const RESULT_TEXT_TRUNCATE_LIMIT = 4000;

interface OpenHandsTextContent {
  type?: string;
  text?: string;
}

interface OpenHandsEvent {
  kind?: string;
  id?: string;
  timestamp?: string;
  source?: string;
  llm_message?: {
    role?: string;
    content?: OpenHandsTextContent[];
  };
  // ActionEvent fields
  thought?: OpenHandsTextContent[];
  action?: Record<string, unknown> | null;
  tool_name?: string;
  tool_call_id?: string;
  tool_call?: { arguments?: string } | null;
  // ObservationEvent / result fields
  action_id?: string;
  observation?: {
    content?: OpenHandsTextContent[];
    is_error?: boolean;
  } | null;
  error?: string;
  rejection_reason?: string;
}

function joinTextContent(content: OpenHandsTextContent[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

/**
 * OpenHands timestamps are naive local datetimes (no timezone suffix) in most
 * deployments. Treat suffix-less timestamps as UTC so ordering is stable.
 */
function normalizeOpenHandsTimestamp(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return `${value}Z`;
}

function truncateResultText(text: string): string {
  if (text.length <= RESULT_TEXT_TRUNCATE_LIMIT) return text;
  return `${text.slice(0, RESULT_TEXT_TRUNCATE_LIMIT)}… [truncated]`;
}

interface ToolResult {
  resultText: string;
  resultOk: boolean;
}

function extractToolResult(event: OpenHandsEvent): ToolResult | null {
  switch (event.kind) {
    case "ObservationEvent":
      return {
        resultText: joinTextContent(event.observation?.content),
        resultOk: event.observation?.is_error !== true,
      };
    case "AgentErrorEvent":
      return { resultText: event.error ?? "", resultOk: false };
    case "UserRejectObservation":
      return { resultText: event.rejection_reason ?? "", resultOk: false };
    default:
      return null;
  }
}

function actionArgsText(event: OpenHandsEvent): string | undefined {
  const raw = event.tool_call?.arguments;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (event.action && typeof event.action === "object") {
    const { kind: _kind, ...rest } = event.action;
    return JSON.stringify(rest);
  }
  return undefined;
}

/**
 * Convert OpenHands conversation events (from
 * GET /api/v1/conversation/{id}/events/search) into transcript entries the
 * reflection machinery can process. Non-conversational events (system
 * prompts, state updates, condensation, streaming deltas) are skipped.
 */
export function convertOpenHandsEvents(
  events: OpenHandsEvent[],
): ExternalTranscriptEntry[] {
  const resultsByToolCallId = new Map<string, ToolResult>();
  const resultsByActionId = new Map<string, ToolResult>();
  for (const event of events) {
    const result = extractToolResult(event);
    if (!result) continue;
    if (event.tool_call_id) resultsByToolCallId.set(event.tool_call_id, result);
    if (event.action_id) resultsByActionId.set(event.action_id, result);
  }

  const entries: ExternalTranscriptEntry[] = [];
  for (const event of events) {
    if (!event.id) continue;
    const capturedAt = normalizeOpenHandsTimestamp(event.timestamp);

    if (event.kind === "MessageEvent") {
      if (event.source !== "user" && event.source !== "agent") continue;
      const text = joinTextContent(event.llm_message?.content);
      if (!text) continue;
      entries.push({
        kind: event.source === "user" ? "user" : "assistant",
        text,
        captured_at: capturedAt,
        source_message_id: event.id,
      });
      continue;
    }

    if (event.kind === "ActionEvent") {
      // Batched tool-call turns produce no MessageEvent; the assistant text
      // rides on the first ActionEvent's `thought`.
      const thought = joinTextContent(event.thought);
      if (thought) {
        entries.push({
          kind: "assistant",
          text: thought,
          captured_at: capturedAt,
          source_message_id: `${event.id}:thought`,
        });
      }
      const result =
        (event.tool_call_id
          ? resultsByToolCallId.get(event.tool_call_id)
          : undefined) ?? resultsByActionId.get(event.id);
      entries.push({
        kind: "tool_call",
        name: event.tool_name,
        argsText: actionArgsText(event),
        resultText: result ? truncateResultText(result.resultText) : undefined,
        resultOk: result?.resultOk,
        captured_at: capturedAt,
        source_message_id: event.id,
      });
    }
  }
  return entries;
}

function parseOpenHandsEventsFile(raw: string, path: string): OpenHandsEvent[] {
  const parsed = safeJsonParseOr<unknown>(raw, null);
  if (Array.isArray(parsed)) return parsed as OpenHandsEvent[];
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { items?: unknown[] }).items)
  ) {
    return (parsed as { items: OpenHandsEvent[] }).items;
  }
  throw new Error(
    `Could not parse ${path}: expected a JSON array of events or {"items": [...]}`,
  );
}

/**
 * Reads a local OpenHands events JSON file (an array, or the
 * `{ items: [...] }` envelope returned by the events API) and converts it.
 */
export const openHandsAdapter: SourceAdapter = {
  type: "openhands",
  async convert(locator: string): Promise<ExternalTranscriptEntry[]> {
    const raw = await readFile(locator, "utf-8");
    return convertOpenHandsEvents(parseOpenHandsEventsFile(raw, locator));
  },
};
