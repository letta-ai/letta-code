import {
  type ApprovalClassification,
  type ClassifyApprovalsOptions,
  classifyApprovals,
} from "../../cli/helpers/approvalClassification";
import type { ApprovalRequest } from "../../cli/helpers/stream";
import type { ApprovalContext } from "../../permissions/analyzer";
import { analyzeToolApproval, savePermissionRule } from "../../tools/manager";
import type {
  ApprovalResponseAllowDecision,
  PermissionSuggestion,
} from "../../types/protocol_v2";

type SuggestedApprovalClassification = ApprovalClassification<ApprovalContext>;

type PermissionSuggestionDefinition = {
  suggestion: PermissionSuggestion;
  rule: string;
  scope: ApprovalContext["defaultScope"];
};

function getSuggestedPermissionRule(
  context: ApprovalContext | null,
): string | null {
  if (
    !context?.allowPersistence ||
    context.recommendedRule.trim().length === 0
  ) {
    return null;
  }
  return context.recommendedRule;
}

function getApprovalPermissionSuggestions(
  context: ApprovalContext | null,
): PermissionSuggestionDefinition[] {
  const suggestedRule = getSuggestedPermissionRule(context);
  if (suggestedRule === null || !context) {
    return [];
  }

  const text = context.approveAlwaysText.trim();
  if (text.length === 0) {
    return [];
  }

  return [
    {
      suggestion: {
        id: "save-default",
        text,
      },
      rule: suggestedRule,
      scope: context.defaultScope,
    },
  ];
}

export function buildApprovalSuggestionPayload(
  context: ApprovalContext | null,
): {
  permission_suggestions: PermissionSuggestion[];
} {
  return {
    permission_suggestions: getApprovalPermissionSuggestions(context).map(
      ({ suggestion }) => suggestion,
    ),
  };
}

export async function classifyApprovalsWithSuggestions(
  approvals: ApprovalRequest[],
  opts: Omit<ClassifyApprovalsOptions<ApprovalContext>, "getContext"> = {},
): Promise<SuggestedApprovalClassification> {
  return classifyApprovals(approvals, {
    ...opts,
    getContext: async (toolName, parsedArgs, workingDirectory) =>
      analyzeToolApproval(toolName, parsedArgs, workingDirectory),
  });
}

export async function applySuggestedPermissionsForApproval(params: {
  decision: ApprovalResponseAllowDecision;
  context: ApprovalContext | null;
  workingDirectory: string;
}): Promise<boolean> {
  const { decision, context, workingDirectory } = params;
  if (!context?.allowPersistence || context.defaultScope === undefined) {
    return false;
  }

  const selectedIds = decision.selected_permission_suggestion_ids ?? [];
  if (selectedIds.length === 0) {
    return false;
  }

  const matchedSuggestions = getApprovalPermissionSuggestions(context).filter(
    ({ suggestion }) => selectedIds.includes(suggestion.id),
  );
  if (matchedSuggestions.length === 0) {
    return false;
  }

  for (const matchedSuggestion of matchedSuggestions) {
    await savePermissionRule(
      matchedSuggestion.rule,
      "allow",
      matchedSuggestion.scope,
      workingDirectory,
    );
  }

  return true;
}
