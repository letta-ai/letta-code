import type {
  NormalizedRecord,
  NormalizedSession,
} from "@/agent/trajectories/types";
import type { ExternalTranscriptEntry } from "@/cli/helpers/reflection-transcript";

function sourceIdPrefix(session: NormalizedSession): string {
  return `${session.session.harness}:${session.session.sessionId}`;
}

function toolResultsByCallId(
  records: NormalizedRecord[],
): Map<string, NormalizedRecord> {
  const byId = new Map<string, NormalizedRecord>();
  for (const record of records) {
    if (record.role === "tool" && record.tool_call_id) {
      byId.set(record.tool_call_id, record);
    }
  }
  return byId;
}

function resultOk(content: string | null | undefined): boolean | undefined {
  if (content === undefined || content === null) return undefined;
  return !/^error\b/i.test(content.trimStart());
}

export function normalizedSessionToExternalEntries(
  session: NormalizedSession,
): ExternalTranscriptEntry[] {
  const prefix = sourceIdPrefix(session);
  const results = toolResultsByCallId(session.records);
  const entries: ExternalTranscriptEntry[] = [];

  for (const [index, record] of session.records.entries()) {
    const captured_at = record.timestamp;
    const source_message_id = `${prefix}:${index}`;

    if (record.role === "meta") continue;

    if (record.role === "user" || record.role === "reasoning") {
      if (typeof record.content !== "string" || record.content.length === 0) {
        continue;
      }
      entries.push({
        kind: record.role,
        text: record.content,
        captured_at,
        source_message_id,
      });
      continue;
    }

    if (record.role === "assistant") {
      if (record.tool_calls?.length) {
        for (const [callIndex, call] of record.tool_calls.entries()) {
          const result = results.get(call.id);
          const resultText =
            typeof result?.content === "string" ? result.content : undefined;
          entries.push({
            kind: "tool_call",
            name: call.name,
            argsText: call.args,
            resultText,
            resultOk: resultOk(resultText),
            captured_at,
            source_message_id: `${source_message_id}:tool:${callIndex}:${call.id}`,
          });
        }
      } else if (
        typeof record.content === "string" &&
        record.content.length > 0
      ) {
        entries.push({
          kind: "assistant",
          text: record.content,
          captured_at,
          source_message_id,
        });
      }
    }
  }

  return entries;
}

export function normalizedSessionsToExternalEntries(
  sessions: NormalizedSession[],
): ExternalTranscriptEntry[] {
  return sessions.flatMap((session) =>
    normalizedSessionToExternalEntries(session),
  );
}
