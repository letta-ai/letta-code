import type { ApprovalContext } from "../../permissions/analyzer";
import { checkToolPermission, getToolSchema } from "../../tools/manager";
import { safeJsonParseOr } from "./safeJsonParse";
import type { ApprovalRequest } from "./streamProcessor";

type ToolPermission = Awaited<ReturnType<typeof checkToolPermission>>;

export type ClassifiedApproval<TContext = ApprovalContext | null> = {
  approval: ApprovalRequest;
  permission: ToolPermission;
  context: TContext | null;
  parsedArgs: Record<string, unknown>;
  missingRequiredArgs?: string[];
  denyReason?: string;
};

export type ApprovalClassification<TContext = ApprovalContext | null> = {
  needsUserInput: ClassifiedApproval<TContext>[];
  autoAllowed: ClassifiedApproval<TContext>[];
  autoDenied: ClassifiedApproval<TContext>[];
};

export type ClassifyApprovalsOptions<TContext = ApprovalContext | null> = {
  getContext?: (
    toolName: string,
    parsedArgs: Record<string, unknown>,
  ) => Promise<TContext>;
  alwaysRequiresUserInput?: (toolName: string) => boolean;
  treatAskAsDeny?: boolean;
  denyReasonForAsk?: string;
  missingNameReason?: string;
  requireArgsForAutoApprove?: boolean;
  missingArgsReason?: (missing: string[]) => string;
};

export async function getMissingRequiredArgs(
  toolName: string,
  parsedArgs: Record<string, unknown>,
): Promise<string[]> {
  const schema = getToolSchema(toolName);
  const required =
    (schema?.input_schema?.required as string[] | undefined) || [];
  return required.filter(
    (key) => !(key in parsedArgs) || parsedArgs[key] == null,
  );
}

export async function classifyApprovals<TContext = ApprovalContext | null>(
  approvals: ApprovalRequest[],
  opts: ClassifyApprovalsOptions<TContext> = {},
): Promise<ApprovalClassification<TContext>> {
  const needsUserInput: ClassifiedApproval<TContext>[] = [];
  const autoAllowed: ClassifiedApproval<TContext>[] = [];
  const autoDenied: ClassifiedApproval<TContext>[] = [];
  const denyReasonForAsk =
    opts.denyReasonForAsk ?? "Tool requires approval (headless mode)";
  const missingNameReason =
    opts.missingNameReason ?? "Tool call incomplete - missing name";

  for (const approval of approvals) {
    const toolName = approval.toolName;
    if (!toolName) {
      autoDenied.push({
        approval,
        permission: { decision: "deny", reason: missingNameReason },
        context: null,
        parsedArgs: {},
        denyReason: missingNameReason,
      });
      continue;
    }

    const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
      approval.toolArgs || "{}",
      {},
    );
    const permission = await checkToolPermission(toolName, parsedArgs);
    const context = opts.getContext
      ? await opts.getContext(toolName, parsedArgs)
      : null;
    let decision = permission.decision;

    if (opts.alwaysRequiresUserInput?.(toolName) && decision === "allow") {
      decision = "ask";
    }

    if (decision === "ask" && opts.treatAskAsDeny) {
      autoDenied.push({
        approval,
        permission,
        context,
        parsedArgs,
        denyReason: denyReasonForAsk,
      });
      continue;
    }

    if (decision === "allow" && opts.requireArgsForAutoApprove) {
      const missingRequiredArgs = await getMissingRequiredArgs(
        toolName,
        parsedArgs,
      );
      if (missingRequiredArgs.length > 0) {
        const denyReason = opts.missingArgsReason
          ? opts.missingArgsReason(missingRequiredArgs)
          : `Missing required parameter${missingRequiredArgs.length > 1 ? "s" : ""}: ${missingRequiredArgs.join(", ")}`;
        autoDenied.push({
          approval,
          permission,
          context,
          parsedArgs,
          missingRequiredArgs,
          denyReason,
        });
        continue;
      }
    }

    const entry: ClassifiedApproval<TContext> = {
      approval,
      permission,
      context,
      parsedArgs,
    };

    if (decision === "ask") {
      needsUserInput.push(entry);
    } else if (decision === "deny") {
      autoDenied.push(entry);
    } else {
      autoAllowed.push(entry);
    }
  }

  return { needsUserInput, autoAllowed, autoDenied };
}
