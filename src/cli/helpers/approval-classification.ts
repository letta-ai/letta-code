import type { ApprovalContext } from "@/permissions/analyzer";
import {
  checkToolPermission,
  getToolSchema,
  type PermissionModeState,
} from "@/tools/manager";
import { safeJsonParseOr } from "./safe-json-parse";
import type { ApprovalRequest } from "./stream-processor";

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
    workingDirectory?: string,
  ) => Promise<TContext>;
  alwaysRequiresUserInput?: (toolName: string) => boolean;
  treatAskAsDeny?: boolean;
  denyReasonForAsk?: string;
  missingNameReason?: string;
  requireArgsForAutoApprove?: boolean;
  missingArgsReason?: (missing: string[]) => string;
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  agentId?: string;
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

function formatMissingRequiredArgsReason(
  toolName: string,
  parsedArgs: Record<string, unknown>,
  missingRequiredArgs: string[],
): string {
  const received = Object.keys(parsedArgs).join(", ");
  return (
    `${toolName} tool missing required parameter${missingRequiredArgs.length > 1 ? "s" : ""}: ` +
    `${missingRequiredArgs.join(", ")}. Received parameters: ${received}`
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

    if (opts.requireArgsForAutoApprove) {
      const missingRequiredArgs = await getMissingRequiredArgs(
        toolName,
        parsedArgs,
      );
      if (missingRequiredArgs.length > 0) {
        const denyReason = opts.missingArgsReason
          ? opts.missingArgsReason(missingRequiredArgs)
          : formatMissingRequiredArgsReason(
              toolName,
              parsedArgs,
              missingRequiredArgs,
            );
        autoDenied.push({
          approval,
          permission: { decision: "deny", reason: denyReason },
          context: null,
          parsedArgs,
          missingRequiredArgs,
          denyReason,
        });
        continue;
      }
    }

    const permission = await checkToolPermission(
      toolName,
      parsedArgs,
      opts.workingDirectory,
      opts.permissionModeState,
      opts.agentId,
    );
    const context = opts.getContext
      ? await opts.getContext(toolName, parsedArgs, opts.workingDirectory)
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
