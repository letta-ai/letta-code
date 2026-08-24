import type { ApprovalContext } from "@/permissions/analyzer";
import { checkToolPermission, getToolSchema } from "@/tools/manager";
import type { PermissionModeState } from "@/tools/permission-mode-state";
import { debugWarn } from "@/utils/debug";
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
  toolContextId?: string | null;
};

export async function getMissingRequiredArgs(
  toolName: string,
  parsedArgs: Record<string, unknown>,
  toolContextId?: string | null,
): Promise<string[]> {
  const schema = getToolSchema(toolName, toolContextId);
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
  argsParse?: ParsedToolArgs,
): string {
  const received = Object.keys(parsedArgs).join(", ");
  const base =
    `${toolName} tool missing required parameter${missingRequiredArgs.length > 1 ? "s" : ""}: ` +
    `${missingRequiredArgs.join(", ")}. Received parameters: ${received}`;

  // No arguments at all reached the client. That is almost never the model
  // omitting them: the payload was dropped or truncated in transit. Say so,
  // otherwise the model "fixes" a call that was already correct and retries
  // byte-identically until it burns the turn budget.
  if (argsParse?.parseFailed) {
    return (
      `${base}. The raw arguments (${argsParse.rawLength} chars) were not valid JSON, ` +
      `so they were lost or truncated in transit. Do not resend an identical call - ` +
      `re-issue it with the arguments restructured (e.g. write long payloads to a file first).`
    );
  }
  if (argsParse?.argsEmpty) {
    return (
      `${base}. The tool call arrived with empty arguments, which usually means they were ` +
      `dropped in transit rather than omitted by you. Do not resend an identical call - ` +
      `re-issue it with the arguments restructured (e.g. write long payloads to a file first).`
    );
  }
  return base;
}

type ParsedToolArgs = {
  parsedArgs: Record<string, unknown>;
  /** Raw arguments were non-empty but could not be parsed as JSON. */
  parseFailed: boolean;
  /** Raw arguments were absent, empty, or parsed to an object with no keys. */
  argsEmpty: boolean;
  rawLength: number;
};

function parseToolArgs(rawArgs: string | undefined): ParsedToolArgs {
  const raw = rawArgs ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      parsedArgs: {},
      parseFailed: false,
      argsEmpty: true,
      rawLength: 0,
    };
  }
  const parsed = safeJsonParseOr<Record<string, unknown> | null>(trimmed, null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      parsedArgs: {},
      parseFailed: true,
      argsEmpty: false,
      rawLength: raw.length,
    };
  }
  return {
    parsedArgs: parsed,
    parseFailed: false,
    argsEmpty: Object.keys(parsed).length === 0,
    rawLength: raw.length,
  };
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

    const argsParse = parseToolArgs(approval.toolArgs);
    const parsedArgs = argsParse.parsedArgs;
    if (argsParse.parseFailed) {
      debugWarn(
        "approval-classification",
        `Tool call ${approval.toolCallId} (${toolName}) had unparseable arguments ` +
          `(${argsParse.rawLength} chars); treating as empty`,
      );
    }

    if (opts.requireArgsForAutoApprove) {
      const missingRequiredArgs = await getMissingRequiredArgs(
        toolName,
        parsedArgs,
        opts.toolContextId,
      );
      if (missingRequiredArgs.length > 0) {
        const denyReason = opts.missingArgsReason
          ? opts.missingArgsReason(missingRequiredArgs)
          : formatMissingRequiredArgsReason(
              toolName,
              parsedArgs,
              missingRequiredArgs,
              argsParse,
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
      opts.toolContextId,
      approval.toolCallId,
    );
    const context = opts.getContext
      ? await opts.getContext(toolName, parsedArgs, opts.workingDirectory)
      : null;
    let decision = permission.decision;

    if (opts.alwaysRequiresUserInput?.(toolName) && decision === "allow") {
      decision = "ask";
    }

    const needsHumanApproval = decision === "ask" || decision === "alwaysAsk";

    if (needsHumanApproval && opts.treatAskAsDeny) {
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

    if (needsHumanApproval) {
      needsUserInput.push(entry);
    } else if (decision === "deny") {
      autoDenied.push(entry);
    } else {
      autoAllowed.push(entry);
    }
  }

  return { needsUserInput, autoAllowed, autoDenied };
}
