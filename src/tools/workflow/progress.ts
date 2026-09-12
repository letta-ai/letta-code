/**
 * Progress accumulation and rendering: turns the stream of workflow progress
 * events into a compact text tree, grouped by phase, suitable for streaming
 * back through a tool's onUpdate callback or printing to a terminal.
 */

import type { WorkflowProgressEvent } from "./types.ts";

interface AgentRow {
  callIndex: number;
  label: string;
  status: "queued" | "running" | "done" | "error" | "cached";
  detail?: string;
}

const STATUS_ICON: Record<AgentRow["status"], string> = {
  queued: "·",
  running: "▶",
  done: "✓",
  error: "✗",
  cached: "⟳",
};

export class ProgressTracker {
  private readonly phaseOrder: string[] = [];
  private readonly byPhase = new Map<string, Map<number, AgentRow>>();
  private readonly logs: string[] = [];

  ingest(event: WorkflowProgressEvent): void {
    if (event.kind === "log") {
      this.logs.push(event.message);
      if (this.logs.length > 20) this.logs.shift();
      return;
    }
    if (event.kind === "phase") {
      this.ensurePhase(event.title);
      return;
    }
    const phaseTitle = event.phase ?? "(no phase)";
    const rows = this.ensurePhase(phaseTitle);
    rows.set(event.callIndex, {
      callIndex: event.callIndex,
      label: event.label,
      status: event.status,
      detail: event.detail,
    });
  }

  private ensurePhase(title: string): Map<number, AgentRow> {
    let rows = this.byPhase.get(title);
    if (!rows) {
      rows = new Map();
      this.byPhase.set(title, rows);
      this.phaseOrder.push(title);
    }
    return rows;
  }

  render(): string {
    const lines: string[] = [];
    for (const title of this.phaseOrder) {
      const rows = [...(this.byPhase.get(title)?.values() ?? [])].sort(
        (a, b) => a.callIndex - b.callIndex,
      );
      const done = rows.filter(
        (r) => r.status === "done" || r.status === "cached",
      ).length;
      lines.push(`${title} (${done}/${rows.length})`);
      for (const row of rows) {
        const suffix = row.detail ? ` — ${row.detail}` : "";
        lines.push(`  ${STATUS_ICON[row.status]} ${row.label}${suffix}`);
      }
    }
    if (this.logs.length > 0) {
      lines.push("", ...this.logs.map((l) => `» ${l}`));
    }
    return lines.join("\n");
  }
}
