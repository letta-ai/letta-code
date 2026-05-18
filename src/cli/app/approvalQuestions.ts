import { safeJsonParseOr } from "../helpers/safeJsonParse";
import type { ApprovalRequest } from "../helpers/stream";

// Extract questions from AskUserQuestion tool args
export function getQuestionsFromApproval(approval: ApprovalRequest) {
  const parsed = safeJsonParseOr<Record<string, unknown>>(
    approval.toolArgs,
    {},
  );
  return (
    (parsed.questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>) || []
  );
}
