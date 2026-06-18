import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import type { ApprovalRequest } from "@/cli/helpers/stream";

export type AskUserQuestionOption = { label: string; description: string };

export type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
  allowOther?: boolean;
};

/**
 * Parse and validate the `questions` array from an AskUserQuestion tool call.
 *
 * The TUI renders a pending AskUserQuestion approval before the tool
 * implementation can reject bad args, so malformed shapes must never reach the
 * renderer. InlineQuestionApproval derefs `question` (`.includes()`), renders
 * `header`/`option.description` as React children, and spreads `options`, so a
 * non-string `question`/`header`/`description` or a non-array `options` throws
 * and bricks the TUI on startup.
 *
 * Returns [] for anything malformed so callers fall through to a safe generic
 * approval path. This is the single source of truth shared by both the
 * ApprovalSwitch render path and the use-approval-flow submit path, to avoid
 * the dual-validation drift flagged in the architecture notes.
 */
export function parseAskUserQuestions(
  approval: ApprovalRequest,
): AskUserQuestion[] {
  const parsed = safeJsonParseOr<unknown>(approval.toolArgs, {});
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const questions = (parsed as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) return [];
  return questions.every(isWellFormedQuestion)
    ? (questions as AskUserQuestion[])
    : [];
}

function isWellFormedQuestion(q: unknown): boolean {
  if (q == null || typeof q !== "object") return false;
  const question = q as Record<string, unknown>;
  if (typeof question.question !== "string") return false;
  if (typeof question.header !== "string") return false;
  if (typeof question.multiSelect !== "boolean") return false;
  if (
    question.allowOther !== undefined &&
    typeof question.allowOther !== "boolean"
  ) {
    return false;
  }
  const options = question.options;
  if (!Array.isArray(options) || options.length === 0) return false;
  return options.every(isWellFormedOption);
}

function isWellFormedOption(o: unknown): boolean {
  if (o == null || typeof o !== "object") return false;
  const option = o as Record<string, unknown>;
  return (
    typeof option.label === "string" &&
    option.label.length > 0 &&
    typeof option.description === "string"
  );
}
