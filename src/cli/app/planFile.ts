import { existsSync, readFileSync } from "node:fs";
import { permissionMode } from "../../permissions/mode";

// Check if plan file exists
export function planFileExists(fallbackPlanFilePath?: string | null): boolean {
  const planFilePath = permissionMode.getPlanFilePath() ?? fallbackPlanFilePath;
  return !!planFilePath && existsSync(planFilePath);
}

// Read plan content from the plan file
export function _readPlanFile(fallbackPlanFilePath?: string | null): string {
  const planFilePath = permissionMode.getPlanFilePath() ?? fallbackPlanFilePath;
  if (!planFilePath) {
    return "No plan file path set.";
  }
  if (!existsSync(planFilePath)) {
    return `Plan file not found at ${planFilePath}`;
  }
  try {
    return readFileSync(planFilePath, "utf-8");
  } catch {
    return `Failed to read plan file at ${planFilePath}`;
  }
}
