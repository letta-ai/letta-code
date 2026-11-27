import type {
  TranscriptRow,
  TranscriptToolCallRow,
} from "@letta-ai/letta-agent-sdk/client";

export type TuiItem =
  | {
      kind: "user";
      id: string;
      text: string;
      otid?: string;
      pending?: boolean;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      phase: "streaming" | "finished";
    }
  | {
      kind: "reasoning";
      id: string;
      text: string;
      phase: "streaming" | "finished";
    }
  | {
      kind: "tool_call";
      id: string;
      toolCallId: string;
      name: string;
      argsText: string;
      resultText?: string;
      resultOk?: boolean;
      phase: "streaming" | "ready" | "running" | "finished";
    }
  | { kind: "error"; id: string; text: string }
  | { kind: "status"; id: string; lines: string[] };

export interface LocalRow {
  anchor: number;
  item: TuiItem;
}

export interface ProjectionInput {
  rows: readonly TranscriptRow[];
  localRows: readonly LocalRow[];
  running: boolean;
  awaitingApprovalToolCallIds: ReadonlySet<string>;
}

function toolPhase(
  row: TranscriptToolCallRow,
  input: ProjectionInput,
): "streaming" | "ready" | "running" | "finished" {
  if (row.status === "complete") return "finished";
  if (!input.running) return "finished";
  if (input.awaitingApprovalToolCallIds.has(row.toolCallId)) return "ready";
  return row.status === "streaming" ? "streaming" : "running";
}

function toolArgsText(row: TranscriptToolCallRow): string {
  if (row.argumentsComplete || !row.rawArguments) {
    return JSON.stringify(row.toolInput);
  }
  return row.rawArguments;
}

export function userItemId(row: { key: string; otid?: string }): string {
  return row.otid ?? row.key;
}

function newestTextKey(rows: readonly TranscriptRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (row.kind === "assistant" || row.kind === "reasoning") return row.key;
    if (row.kind === "user") return null;
  }
  return null;
}

function projectRow(
  row: TranscriptRow,
  liveKey: string | null,
  input: ProjectionInput,
): TuiItem {
  if (row.kind === "tool_call") {
    return {
      kind: "tool_call",
      id: row.key,
      toolCallId: row.toolCallId,
      name: row.toolName,
      argsText: toolArgsText(row),
      resultText: row.result?.content,
      resultOk: row.result ? !row.result.isError : undefined,
      phase: toolPhase(row, input),
    };
  }
  if (row.kind === "user") {
    return {
      kind: "user",
      id: userItemId(row),
      text: row.text,
      otid: row.otid,
    };
  }
  return {
    kind: row.kind,
    id: row.key,
    text: row.text,
    phase: row.key === liveKey ? "streaming" : "finished",
  };
}

export function projectItems(input: ProjectionInput): TuiItem[] {
  const liveKey = input.running ? newestTextKey(input.rows) : null;
  const items: TuiItem[] = [];
  const count = input.rows.length;
  for (let index = 0; index <= count; index += 1) {
    for (const local of input.localRows) {
      const anchor = Math.min(local.anchor, count);
      if (anchor === index) items.push(local.item);
    }
    const row = input.rows[index];
    if (row) items.push(projectRow(row, liveKey, input));
  }
  return items;
}

export function isFinalItem(item: TuiItem): boolean {
  switch (item.kind) {
    case "user":
      return item.pending !== true;
    case "assistant":
    case "reasoning":
      return item.phase === "finished";
    case "tool_call":
      return item.phase === "finished";
    default:
      return true;
  }
}

export function countCommittedPrefix(items: readonly TuiItem[]): number {
  let count = 0;
  for (const item of items) {
    if (!isFinalItem(item)) break;
    count += 1;
  }
  return count;
}
