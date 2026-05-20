import type { ClassifiedApproval } from "@/cli/helpers/approvalClassification";
import {
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "@/cli/helpers/diff";
import { parsePatchOperations } from "@/cli/helpers/formatArgsDisplay";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
} from "@/cli/helpers/toolNameMapping";

export function buildApprovalBatchKey(approvals: ApprovalRequest[]): string {
  return approvals
    .map((approval) => approval.toolCallId)
    .sort()
    .join("|");
}

export function _precomputeDiffsForApprovalBatch(
  approvals: Array<Pick<ClassifiedApproval, "approval" | "parsedArgs">>,
  precomputedDiffs: Map<string, AdvancedDiffSuccess>,
): void {
  for (const ac of approvals) {
    const toolName = ac.approval.toolName;
    const toolCallId = ac.approval.toolCallId;
    const args = ac.parsedArgs;

    try {
      if (isFileWriteTool(toolName)) {
        const filePath = args.file_path as string | undefined;
        if (filePath) {
          const result = computeAdvancedDiff({
            kind: "write",
            filePath,
            content: (args.content as string) || "",
          });
          if (result.mode === "advanced") {
            precomputedDiffs.set(toolCallId, result);
          }
        }
      } else if (isFileEditTool(toolName)) {
        const filePath = args.file_path as string | undefined;
        if (filePath) {
          if (args.edits && Array.isArray(args.edits)) {
            const result = computeAdvancedDiff({
              kind: "multi_edit",
              filePath,
              edits: args.edits as Array<{
                old_string: string;
                new_string: string;
                replace_all?: boolean;
              }>,
            });
            if (result.mode === "advanced") {
              precomputedDiffs.set(toolCallId, result);
            }
          } else {
            const result = computeAdvancedDiff({
              kind: "edit",
              filePath,
              oldString: (args.old_string as string) || "",
              newString: (args.new_string as string) || "",
              replaceAll: args.replace_all as boolean | undefined,
            });
            if (result.mode === "advanced") {
              precomputedDiffs.set(toolCallId, result);
            }
          }
        }
      } else if (isPatchTool(toolName) && args.input) {
        const operations = parsePatchOperations(args.input as string);
        for (const op of operations) {
          const key = `${toolCallId}:${op.path}`;
          if (op.kind === "add" || op.kind === "update") {
            const result = parsePatchToAdvancedDiff(op.patchLines, op.path);
            if (result) {
              precomputedDiffs.set(key, result);
            }
          }
        }
      }
    } catch {
      // Ignore diff computation errors for approval previews.
    }
  }
}
