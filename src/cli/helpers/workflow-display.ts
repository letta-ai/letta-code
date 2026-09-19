/**
 * Plain-text rendering of workflow execution status for the /workflows
 * command: one block per run, agents grouped by phase, with duration and
 * token usage per agent.
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

const RUN_STATUS_GLYPHS: Record<WorkflowExecutionSnapshot["status"], string> = {
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
  const progress = formatWorkflowProgress(snapshot);
  const lines = [
    `${RUN_STATUS_GLYPHS[snapshot.status]} ${snapshot.name} — ${snapshot.description}`,
    `  ${snapshot.status === "failed" ? `${progress} · failed` : progress}`,
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
