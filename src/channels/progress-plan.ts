import {
  asRecord,
  parseToolArguments,
  sanitizeChannelProgressText,
  type ToolCallSummary,
} from "./progress-formatting";
import type { ChannelTurnProgressUpdate } from "./progress-types";

/** These two tools explicitly publish plans. Never project arbitrary tool
 * arguments, shell output or partial model deltas into plan rows. */
export function completedToolPlan(
  tool: ToolCallSummary | null | undefined,
  state: string,
): Pick<ChannelTurnProgressUpdate, "plan"> {
  if (state !== "completed" || !tool?.argumentsText) return {};
  const isPlan = tool.name === "UpdatePlan" || tool.name === "update_plan";
  const isTodo = tool.name === "TodoWrite" || tool.name === "todo_write";
  if (!isPlan && !isTodo) return {};
  const args = parseToolArguments(tool.argumentsText);
  const rows = args?.[isPlan ? "plan" : "todos"];
  if (!Array.isArray(rows) || rows.length > 50) return {};
  const plan: NonNullable<ChannelTurnProgressUpdate["plan"]> = [];
  for (const [index, value] of rows.entries()) {
    const row = asRecord(value);
    const text = row?.[isPlan ? "step" : "content"];
    if (
      typeof text !== "string" ||
      !["pending", "in_progress", "completed"].includes(String(row?.status))
    )
      return {};
    const title = sanitizeChannelProgressText(text, 200);
    if (!title) return {};
    plan.push({
      id: `plan-${index}`,
      title,
      status:
        row?.status === "completed"
          ? "complete"
          : (row?.status as "pending" | "in_progress"),
    });
  }
  return { plan };
}
