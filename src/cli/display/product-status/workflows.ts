/**
 * Built-in status rows for Workflow runs, rendered below the input:
 *
 *   ○ simple-demo                 0/3 agents done · 9s · 133.6k tokens
 *     Quick demo workflow with parallel agents
 *
 * Each run occupies two lines: running ones always, finished ones for a short
 * linger so the final numbers remain visible before the row disappears.
 */

import { colors } from "@/cli/components/colors";
import {
  truncateToWidth,
  visibleWidth,
} from "@/cli/display/statusline/formatting";
import { formatWorkflowStatusRow } from "@/cli/helpers/workflow-display";
import type { ModPanel } from "@/cli/mods/types";
import type { WorkflowExecutionSnapshot } from "@/tools/workflow/execution-registry";

/** Negative orders stack below the primary line under the input. */
export const WORKFLOW_STATUS_PANEL_ORDER = -1;
export const WORKFLOW_STATUS_PANEL_ID = "default:workflows";
export const WORKFLOW_ROW_LINGER_MS = 30_000;
const MAX_WORKFLOW_ROWS = 3;
const WORKFLOW_DESCRIPTION_INDENT = "  ";

const GLYPH_COLORS: Record<WorkflowExecutionSnapshot["status"], string> = {
  running: colors.tool.running,
  completed: colors.tool.completed,
  failed: colors.status.interrupt,
};

/** Runs worth a row right now: running, or finished very recently. */
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
      const prioritized = [...executions].sort((a, b) => {
        if (a.status === "running" && b.status !== "running") return -1;
        if (b.status === "running" && a.status !== "running") return 1;
        return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
      });
      const lines = prioritized
        .slice(0, MAX_WORKFLOW_ROWS)
        .flatMap((execution) => {
          const row = formatWorkflowStatusRow(execution);
          const glyph = ctx.chalk.hex(GLYPH_COLORS[execution.status])(
            row.glyph,
          );
          const name = `${glyph} ${row.name}`;
          const progressBudget = ctx.width - visibleWidth(name) - 1;
          const [count, ...details] = row.progress.split(" · ");
          const failedSuffix = execution.status === "failed" ? " · failed" : "";
          const metrics = failedSuffix ? details.slice(0, -1) : details;
          let progressText = count ?? "";
          for (const detail of metrics) {
            const candidate = `${progressText} · ${detail}${failedSuffix}`;
            if (visibleWidth(candidate) > progressBudget) break;
            progressText = `${progressText} · ${detail}`;
          }
          const progress = ctx.chalk.dim(`${progressText}${failedSuffix}`);
          const description = `${WORKFLOW_DESCRIPTION_INDENT}${row.description}`;
          // Keep progress on the first line; a long description should not
          // consume the left budget and clip the workflow name.
          return [
            ctx.row(name, progress, ctx.width),
            ctx.chalk.dim(
              visibleWidth(description) > ctx.width
                ? truncateToWidth(description, ctx.width)
                : description,
            ),
          ];
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
