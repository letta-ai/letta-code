import { validateRequiredParams } from "./validation.js";

type PlanStatus = "pending" | "in_progress" | "completed";

interface PlanItem {
  step: string;
  status: PlanStatus;
}

interface UpdatePlanArgs {
  explanation?: string;
  plan: PlanItem[];
}

interface UpdatePlanResult {
  message: string;
}

/**
 * Codex-style update_plan tool.
 * Validates and records a structured task plan; currently returns a simple acknowledgement.
 */
export async function update_plan(
  args: UpdatePlanArgs,
): Promise<UpdatePlanResult> {
  validateRequiredParams(args, ["plan"], "update_plan");

  if (!Array.isArray(args.plan) || args.plan.length === 0) {
    throw new Error("plan must be a non-empty array of items");
  }

  let inProgressCount = 0;
  for (const item of args.plan) {
    if (!item.step || typeof item.step !== "string") {
      throw new Error("Each plan item must include a non-empty step string");
    }
    if (!item.status || !["pending", "in_progress", "completed"].includes(item.status)) {
      throw new Error(
        "Each plan item must have a valid status: pending, in_progress, or completed",
      );
    }
    if (item.status === "in_progress") {
      inProgressCount += 1;
    }
  }

  if (inProgressCount > 1) {
    throw new Error("At most one plan item can have status in_progress at a time");
  }

  return {
    message: "Plan updated",
  };
}



