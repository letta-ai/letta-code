import {
  type AskUserQuestion,
  parseAskUserQuestions,
} from "@/cli/helpers/ask-user-questions";
import type { ApprovalRequest } from "@/cli/helpers/stream";

// Extract questions from an AskUserQuestion tool call's args. Delegates to the
// shared parseAskUserQuestions validator (single source of truth shared with
// the ApprovalSwitch render path) so malformed shapes are rejected rather than
// reaching the submit handler. Returns [] for anything malformed.
export function getQuestionsFromApproval(
  approval: ApprovalRequest,
): AskUserQuestion[] {
  return parseAskUserQuestions(approval);
}
