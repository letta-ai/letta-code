/**
 * Built-in status rows for Workflow executions, rendered below the input:
 *
 *   ○ simple-demo  Quick demo workflow with parallel agents   0/3 agents done · 9s · ↓ 133.6k tokens
 *
 * One row per execution: running ones always, finished ones for a short
 * linger so the final numbers are visible before the row disappears.
 */

import { colors } from "@/cli/components/colors";
import { formatWorkflowStatusRow } from "@/cli/helpers/workflow-display";
import type { ModPanel } from "@/cli/mods/types";
import type { WorkflowExecutionSnapshot } from "@/tools/workflow/execution-registry";

/** Negative orders stack below the primary line under the input. */
export const WORKFLOW_STATUS_PANEL_ORDER = -1;
export const WORKFLOW_STATUS_PANEL_ID = "default:workflows";
export const WORKFLOW_ROW_LINGER_MS = 30_000;
const MAX_WORKFLOW_ROWS = 4;

const GLYPH_COLORS: Record<WorkflowExecutionSnapshot["status"], string> = {
  running: colors.tool.running,
  completed: colors.tool.completed,
  failed: colors.status.interrupt,
};

/** Executions worth a row right now: running, or finished very recently. */
export function visibleWorkflowExecutions(
  executions: WorkflowExecutionSnapshot[],
  now = Date.now(),
): WorkflowExecutionSnapshot[] {
  return executions.filter(
    (execution) =>
      execution.status === "running" ||
      (execution.finishedAt !== undefined &&
        now - execution.finishedAt < WORKFLOW_ROW_LINGER_MS),
  );
}

export function createWorkflowStatusPanel(
  executions: WorkflowExecutionSnapshot[],
): ModPanel {
  return {
    id: WORKFLOW_STATUS_PANEL_ID,
    order: WORKFLOW_STATUS_PANEL_ORDER,
    path: WORKFLOW_STATUS_PANEL_ID,
    updatedAt: 0,
    render(ctx) {
      const lines = executions.slice(0, MAX_WORKFLOW_ROWS).map((execution) => {
        const row = formatWorkflowStatusRow(execution);
        const glyph = ctx.chalk.hex(GLYPH_COLORS[execution.status])(row.glyph);
        const left = `${glyph} ${row.name}  ${ctx.chalk.dim(row.description)}`;
        return ctx.row(left, ctx.chalk.dim(row.progress), ctx.width);
      });
      const hidden = executions.length - MAX_WORKFLOW_ROWS;
      if (hidden > 0) {
        lines.push(ctx.chalk.dim(`  +${hidden} more · /workflows`));
      }
      return lines;
    },
  };
}

export function withWorkflowStatusPanel(
  panels: Record<string, ModPanel>,
  executions: WorkflowExecutionSnapshot[],
): Record<string, ModPanel> {
  if (executions.length === 0) return panels;
  const panel = createWorkflowStatusPanel(executions);
  return { ...panels, [panel.id]: panel };
}
