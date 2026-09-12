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
  // safeJsonParseOr returns the raw JSON.parse result, so valid-but-non-object
  // toolArgs (e.g. "null" → null, "true", "42", "[1,2]") reaches here. Guard
  // before dereferencing `.questions` — this parser runs in the render path and
  // a throw bricks the TUI. Reject null, primitives, and arrays.
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const questions = (parsed as Record<string, unknown>).questions;
  // AskUserQuestion contract (src/tools/schemas/AskUserQuestion.json): 1–4
  // questions, each with 2–4 options. The tool implementation
  // (src/tools/impl/ask-user-question.ts) rejects anything outside these
  // bounds on submit, so accept them here too — otherwise we'd render the
  // specialized question UI for a payload guaranteed to be rejected.
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 4
  ) {
    return [];
  }
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
  // 2–4 options per the AskUserQuestion contract (see header comment).
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    return false;
  }
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
