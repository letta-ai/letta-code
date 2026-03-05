import type { PermissionMode } from "../../permissions/mode";

export type PlanExitDecision = "restore" | "manual" | "autoAccept";
export type PlanExitChoice = {
  decision: PlanExitDecision | "custom";
  label: string;
};

function normalizeModeBeforePlan(
  modeBeforePlan: PermissionMode | null | undefined,
): PermissionMode {
  if (!modeBeforePlan || modeBeforePlan === "plan") return "default";
  return modeBeforePlan;
}

export function formatPermissionModeForPlanReturnLabel(
  mode: PermissionMode,
): string {
  switch (mode) {
    case "bypassPermissions":
      return "yolo";
    case "acceptEdits":
      return "auto-accept edits";
    case "default":
      return "manual approvals";
    case "plan":
      return "manual approvals";
  }
}

/**
 * Build the list of choices shown when approving ExitPlanMode.
 *
 * Always includes the "return to previous mode" option as the default.
 * Omits duplicate options when the previous mode already corresponds to
 * manual approvals (default) or auto-accept edits (acceptEdits).
 */
export function getPlanExitChoices(
  modeBeforePlan: PermissionMode | null | undefined,
): PlanExitChoice[] {
  const prev = normalizeModeBeforePlan(modeBeforePlan);
  const prevLabel = formatPermissionModeForPlanReturnLabel(prev);

  const choices: PlanExitChoice[] = [
    {
      decision: "restore",
      label: `Yes, and return to previous mode (${prevLabel})`,
    },
  ];

  // Avoid duplicates.
  if (prev !== "default") {
    choices.push({
      decision: "manual",
      label: "Yes, and manually approve edits",
    });
  }
  if (prev !== "acceptEdits") {
    choices.push({
      decision: "autoAccept",
      label: "Yes, and auto-accept edits",
    });
  }

  choices.push({ decision: "custom", label: "custom" });
  return choices;
}

export function resolvePlanExitMode(
  decision: PlanExitDecision,
  modeBeforePlan: PermissionMode | null | undefined,
): PermissionMode {
  const prev = normalizeModeBeforePlan(modeBeforePlan);
  if (decision === "restore") return prev;
  if (decision === "manual") return "default";
  return "acceptEdits";
}
