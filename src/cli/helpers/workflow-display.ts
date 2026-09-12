/**
 * Pure formatting helpers for the Workflow tool's TUI surfaces: the tool-call
 * header and launch line in the transcript, the status row below the input,
 * the idle "waiting" line, and the /workflows tree.
 */

import { basename } from "node:path";
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
  cached: "⟳",
};

const TASK_ID_PATTERN = /Task ID: (workflow_\d+)/;

/** The background task id announced in a Workflow tool result, if any. */
export function parseWorkflowTaskId(resultText: string): string | null {
  return TASK_ID_PATTERN.exec(resultText)?.[1] ?? null;
}

/**
 * Pull a string field out of the `export const meta = {...}` literal without
 * evaluating the script. Good enough for a header; the engine validates the
 * real thing.
 */
function readMetaString(
  script: string,
  key: "name" | "description",
): string | null {
  const metaStart = script.search(/export\s+const\s+meta\s*=/);
  const region = metaStart >= 0 ? script.slice(metaStart) : script;
  const pattern = new RegExp(
    `\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`,
  );
  const match = pattern.exec(region);
  return match?.[2]?.trim() || null;
}

/**
 * Header text for `Workflow(...)`: the script's own description, falling back
 * to its name or file, never the script body.
 */
export function describeWorkflowArgs(parsed: Record<string, unknown>): string {
  const script = typeof parsed.script === "string" ? parsed.script : "";
  const scriptPath =
    typeof parsed.scriptPath === "string" ? parsed.scriptPath : "";
  const label =
    (script &&
      (readMetaString(script, "description") ??
        readMetaString(script, "name"))) ||
    (scriptPath && basename(scriptPath)) ||
    "…";
  const resumeId =
    typeof parsed.resumeFromExecutionId === "string"
      ? parsed.resumeFromExecutionId
      : "";
  return resumeId ? `${label}, resume ${resumeId}` : label;
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

export function formatWaitingForWorkflows(count: number): string {
  return `Waiting for ${count} workflow${count === 1 ? "" : "s"} to finish`;
}

/** Left/right halves of the status row shown below the input. */
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
  if (agent.status === "cached") parts.push("cached");
  if (agent.durationMs !== undefined) {
    parts.push(formatWorkflowDuration(agent.durationMs));
  }
  if (agent.totalTokens) {
    parts.push(`${formatCompactTokens(agent.totalTokens)} tokens`);
  }
  if (agent.detail) parts.push(agent.detail);
  return parts.join(" · ");
}

/** Plain-text tree for the /workflows command. */
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
    const done = phase.agents.filter(
      (a) => a.status === "done" || a.status === "cached",
    ).length;
    lines.push(`  ${phase.title} (${done}/${phase.agents.length})`);
    for (const agent of phase.agents) {
      lines.push(`    ${formatAgentLine(agent)}`);
    }
  }
  for (const log of snapshot.logs.slice(-5)) {
    lines.push(`  » ${log}`);
  }
  lines.push(
    `  task ${snapshot.taskId} · execution ${snapshot.executionId} · log ${snapshot.outputFile}`,
  );
  return lines;
}
