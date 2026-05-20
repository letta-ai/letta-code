import type { ApprovalRequest } from "@/cli/helpers/stream";

export function buildApprovalBatchKey(approvals: ApprovalRequest[]): string {
  return approvals
    .map((approval) => approval.toolCallId)
    .sort()
    .join("|");
}
