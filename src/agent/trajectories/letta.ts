// Letta agent conversations → normalized-v1.
//
// Reads the locally recorded reflection transcript for one agent conversation
// (`{transcriptRoot}/{agentId}/{conversationId}/transcript.jsonl`, one entry
// per line: user / assistant / reasoning / error prose rows and tool_call rows
// carrying their result inline) and runs it through the shared row pipeline,
// so a letta conversation normalizes exactly like any external harness
// session.
//
// There is no store-wide discovery: the locator names one conversation as
// `<agent-id>/<conversation-id>` (callers canonicalize bare agent ids and
// conversation ids into that form).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTranscriptRoot } from "@/utils/transcript-paths";
import type { PseudoRow } from "./normalize-core";
import { normalizeSessionRows, parseTimestamp } from "./normalize-core";
import { statOrNull } from "./store-utils";
import type {
  DiscoveredSession,
  NormalizedSession,
  TrajectorySource,
} from "./types";
import { estimateTokens } from "./types";

interface LettaTranscriptRow {
  kind?: string;
  text?: string;
  name?: string;
  argsText?: string;
  resultText?: string;
  resultOk?: boolean;
  captured_at?: string;
}

function parseRows(raw: string): LettaTranscriptRow[] {
  const rows: LettaTranscriptRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LettaTranscriptRow;
      if (parsed && typeof parsed === "object" && parsed.kind) {
        rows.push(parsed);
      }
    } catch {
      // Skip unparseable lines rather than failing the whole conversation.
    }
  }
  return rows;
}

function rowsToPseudoRows(rows: LettaTranscriptRow[]): PseudoRow[] {
  const out: PseudoRow[] = [];
  let n = 0;
  for (const row of rows) {
    const timestamp = parseTimestamp(row.captured_at);
    switch (row.kind) {
      case "user":
        if (row.text) {
          out.push({
            role: "user",
            turnType: "user_prompt",
            content: row.text,
            timestamp,
          });
        }
        break;
      case "assistant":
        if (row.text) {
          out.push({
            role: "assistant",
            turnType: "assistant_response",
            content: row.text,
            timestamp,
          });
        }
        break;
      case "reasoning":
        if (row.text) {
          out.push({
            role: "assistant",
            turnType: "assistant_thinking",
            content: row.text,
            timestamp,
          });
        }
        break;
      case "tool_call": {
        n += 1;
        const callId = `letta_${n}`;
        out.push({
          role: "tool_use",
          turnType: "tool_use",
          timestamp,
          toolName: row.name,
          toolCallId: callId,
          toolInputJson: row.argsText || "{}",
        });
        if (row.resultText !== undefined) {
          const content =
            row.resultOk === false && !/^error/i.test(row.resultText)
              ? `Error: ${row.resultText}`
              : row.resultText;
          out.push({
            role: "tool_result",
            turnType: "tool_result",
            content,
            timestamp,
            toolCallId: callId,
          });
        }
        break;
      }
      default:
        // "error" rows and unknown kinds carry no conversational content.
        break;
    }
  }
  return out;
}

function timestampsFromRows(rows: LettaTranscriptRow[]): string[] {
  return rows
    .map((row) => row.captured_at)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

export function createLettaSource(transcriptRoot?: string): TrajectorySource {
  const root = () => transcriptRoot ?? getTranscriptRoot();

  const discoverOne = (locator: string): DiscoveredSession[] => {
    const sep = locator.indexOf("/");
    if (sep <= 0 || sep === locator.length - 1) {
      throw new Error(
        `Invalid letta locator "${locator}": expected <agent-id>/<conversation-id>`,
      );
    }
    const agentId = locator.slice(0, sep);
    const conversationId = locator.slice(sep + 1);
    const transcriptPath = join(
      root(),
      agentId,
      conversationId,
      "transcript.jsonl",
    );
    const info = statOrNull(transcriptPath);
    if (!info?.isFile()) {
      throw new Error(
        `No recorded transcript for conversation "${conversationId}" of ${agentId} (${transcriptPath})`,
      );
    }
    const raw = readFileSync(transcriptPath, "utf-8");
    const rows = parseRows(raw);
    const timestamps = timestampsFromRows(rows);
    if (rows.length === 0 || timestamps.length === 0) {
      return [];
    }
    return [
      {
        harness: "letta",
        sessionId: locator,
        path: transcriptPath,
        startTime: timestamps[0] ?? "",
        endTime: timestamps[timestamps.length - 1] ?? "",
        estTokens: estimateTokens(raw),
        recordCount: rows.length,
        mtimeMs: info.mtimeMs,
      },
    ];
  };

  return {
    type: "letta",
    async discover(locator?: string): Promise<DiscoveredSession[]> {
      if (!locator) {
        throw new Error(
          'The "letta" source needs a locator: letta:<conversation-id>, ' +
            "letta:<agent-id> (its default conversation), or " +
            "letta:<agent-id>/<conversation-id>",
        );
      }
      return discoverOne(locator);
    },
    async normalize(session: DiscoveredSession): Promise<NormalizedSession> {
      const raw = readFileSync(session.path, "utf-8");
      const rows = rowsToPseudoRows(parseRows(raw));
      const result = normalizeSessionRows(rows, { source: "letta" });
      if (result.status !== "ok" || !result.records) {
        throw new Error(
          `Could not normalize letta conversation ${session.sessionId}: ${result.status}`,
        );
      }
      return { session, records: result.records };
    },
  };
}
