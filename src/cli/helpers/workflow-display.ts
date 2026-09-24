/**
 * Pure formatting for the Workflow tool's TUI surfaces: the status rows
 * under the input, the launch line in the transcript, and the /workflows
 * tree (one block per run, agents grouped by phase, with duration and token
 * usage per agent).
 */

import type {
  WorkflowAgentRecord,
  WorkflowExecutionSnapshot,
} from "@/tools/workflow/execution-registry";
import {
  formatCompactTokens,
  formatWorkflowDuration,
  formatWorkflowProgress,
} from "@/tools/workflow/format-stats";

export const WORKFLOW_STATUS_GLYPHS: Record<
  WorkflowExecutionSnapshot["status"],
  string
> = {
  running: "○",
  completed: "●",
  failed: "✗",
};

const AGENT_STATUS_ICONS: Record<WorkflowAgentRecord["status"], string> = {
  queued: "·",
  running: "▶",
  done: "✓",
  error: "✗",
};

const TASK_ID_PATTERN = /Task ID: (workflow_\d+)/;

/** The background task id announced in a Workflow tool result, if any. */
export function parseWorkflowTaskId(resultText: string): string | null {
  return TASK_ID_PATTERN.exec(resultText)?.[1] ?? null;
}

/**
 * One-line transcript summary for a successful launch, or null when the
 * result is not a launch message (validation errors render as-is).
 */
export function formatWorkflowLaunchLine(resultText: string): string | null {
  const taskId = parseWorkflowTaskId(resultText);
  if (!taskId) return null;
  return `Launched in background · task ${taskId} · /workflows to watch`;
}

/** Left/right halves of the status row shown under the input. */
export function formatWorkflowStatusRow(snapshot: WorkflowExecutionSnapshot): {
  glyph: string;
  name: string;
  description: string;
  progress: string;
} {
  const progress = formatWorkflowProgress(snapshot);
  return {
    glyph: WORKFLOW_STATUS_GLYPHS[snapshot.status],
    name: snapshot.name,
    description: snapshot.description,
    progress: snapshot.status === "failed" ? `${progress} · failed` : progress,
  };
}

function formatAgentLine(agent: WorkflowAgentRecord): string {
  const parts = [`${AGENT_STATUS_ICONS[agent.status]} ${agent.label}`];
  if (agent.status === "queued") parts.push("queued");
  if (agent.durationMs !== undefined) {
    parts.push(formatWorkflowDuration(agent.durationMs));
  }
  if (agent.totalTokens) {
    parts.push(`${formatCompactTokens(agent.totalTokens)} tokens`);
  }
  if (agent.detail) parts.push(agent.detail);
  return parts.join(" · ");
}

export function renderWorkflowTree(
  snapshot: WorkflowExecutionSnapshot,
): string[] {
  const row = formatWorkflowStatusRow(snapshot);
  const lines = [
    `${row.glyph} ${row.name} — ${row.description}`,
    `  ${row.progress}`,
  ];
  if (snapshot.error) lines.push(`  error: ${snapshot.error}`);
  for (const phase of snapshot.phases) {
    const done = phase.agents.filter((a) => a.status === "done").length;
    lines.push(`  ${phase.title} (${done}/${phase.agents.length})`);
    for (const agent of phase.agents) {
      lines.push(`    ${formatAgentLine(agent)}`);
    }
  }
  for (const log of snapshot.logs.slice(-5)) {
    lines.push(`  » ${log}`);
  }
  lines.push(`  task ${snapshot.taskId} · log ${snapshot.outputFile}`);
  return lines;
}
