import { isDeepStrictEqual } from "node:util";
import type { SDKMessage, TranscriptRow } from "@letta-ai/letta-agent-sdk";
import {
  type AskUserQuestionReceipt,
  parseAskUserQuestionNotif,
  parseAskUserQuestionReceipt,
} from "@/ask-user-question";
import { stripSystemReminders } from "@/cli/app/system-reminders";
import type { Snapshot } from "@/cli/app/terminal-snapshot";

export class TerminalRowLifecycle {
  private reasoningStart = new Map<string, number>();
  readonly finished = new Set<string>();
  readonly durations = new Map<string, number>();

  project(
    rows: readonly TranscriptRow[],
    echoes: ReadonlyMap<string, unknown>,
    settled: boolean,
  ) {
    const now = Date.now();
    let committed = 0;
    for (const [index, row] of rows.entries()) {
      const finished =
        row.kind === "tool_call"
          ? row.status === "complete" || settled
          : row.kind === "user"
            ? !row.otid || !echoes.has(row.otid) || index < rows.length - 1
            : settled || index < rows.length - 1 || this.finished.has(row.key);
      if (row.kind === "reasoning" && !this.durations.has(row.key)) {
        const start = this.reasoningStart.get(row.key);
        if (finished && start !== undefined) {
          this.durations.set(row.key, now - start);
          this.reasoningStart.delete(row.key);
        } else if (!finished && start === undefined) {
          this.reasoningStart.set(row.key, now);
        }
      }
      if (finished) this.finished.add(row.key);
      else this.finished.delete(row.key);
      if (committed === index && finished) committed++;
    }
    return committed;
  }
}

function sameRenderedRow(
  previous: TranscriptRow,
  next: TranscriptRow | undefined,
  approvedArguments: ReadonlyMap<string, unknown>,
) {
  if (!next || previous.key !== next.key || previous.kind !== next.kind)
    return false;
  if (previous.kind === "user" && next.kind === "user")
    return (
      stripSystemReminders(previous.text) === stripSystemReminders(next.text)
    );
  if (previous.kind === "tool_call" && next.kind === "tool_call") {
    return (
      previous.toolName === next.toolName &&
      previous.status === next.status &&
      previous.result?.content === next.result?.content &&
      previous.result?.isError === next.result?.isError &&
      (approvedArguments.has(previous.toolCallId) ||
        (previous.argumentsComplete && next.argumentsComplete
          ? isDeepStrictEqual(previous.toolInput, next.toolInput)
          : previous.rawArguments === next.rawArguments))
    );
  }
  return (
    previous.kind !== "tool_call" &&
    next.kind !== "tool_call" &&
    previous.text === next.text
  );
}

export function projectTranscript(
  rows: readonly TranscriptRow[],
  settled: boolean,
  previous: Pick<Snapshot, "rows" | "committed" | "epoch" | "notices">,
  lifecycle: TerminalRowLifecycle,
  echoes: Map<string, { anchor?: string; text: string }>,
  pendingAnswers: Set<string>,
  approvedArguments: ReadonlyMap<string, unknown>,
) {
  for (const row of rows) {
    if (row.kind === "user" && row.otid) echoes.delete(row.otid);
  }

  const projected = [...rows];
  for (const [otid, { anchor, text }] of echoes) {
    const index = projected.findIndex(
      (row) =>
        row.key === anchor || (anchor !== undefined && row.otid === anchor),
    );
    projected.splice(index + 1, 0, {
      key: `user:otid:${otid}`,
      otid,
      kind: "user",
      text,
    });
  }
  const answered = new Set(pendingAnswers);
  const questions: AskUserQuestionReceipt[] = [];
  for (const row of projected) {
    if (
      row.kind === "user" &&
      row.text.includes("<ask-user-question-response>")
    ) {
      for (const answer of parseAskUserQuestionNotif(row.text))
        answered.add(answer.toolCallId);
    }
    if (
      row.kind === "tool_call" &&
      row.toolName === "AskUserQuestion" &&
      row.result
    ) {
      const receipt = parseAskUserQuestionReceipt(row.result.content);
      if (receipt) questions.push(receipt);
    }
  }

  const reset = previous.rows
    .slice(0, previous.committed)
    .some(
      (row, index) =>
        row !== projected[index] &&
        !sameRenderedRow(row, projected[index], approvedArguments),
    );
  const committed = lifecycle.project(projected, echoes, settled);
  const notices = reset
    ? previous.notices.map((notice) => {
        const anchor = previous.rows[notice.index - 1];
        const index = anchor
          ? projected.findIndex(
              (row) =>
                row.key === anchor.key ||
                (row.kind === anchor.kind &&
                  !!anchor.otid &&
                  row.otid === anchor.otid),
            )
          : -1;
        return {
          ...notice,
          index: index < 0 ? Math.min(notice.index, committed) : index + 1,
        };
      })
    : previous.notices;
  return {
    notices,
    rows: projected,
    question: questions.find((q) => !answered.has(q.toolCallId)),
    committed,
    epoch: previous.epoch + Number(reset),
  };
}

export function streamBytes(message: SDKMessage) {
  if (message.type === "assistant" || message.type === "reasoning")
    return Buffer.byteLength(message.content);
  if (message.type === "tool_call")
    return Buffer.byteLength(message.rawArguments ?? "");
  return undefined;
}
