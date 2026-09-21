/**
 * In-process registry of Workflow tool runs, kept for status reporting.
 *
 * The Workflow tool launches a run in the background and returns at once; the
 * run then reports progress here. The /workflows command, the status rows
 * under the input, and the completion summary read from it; the TUI
 * subscribes to change notifications so nothing polls. Entries for finished
 * runs are retained for a short while so the final numbers stay visible.
 */

import type { WorkflowMeta, WorkflowProgressEvent } from "./types.ts";

export type WorkflowExecutionStatus = "running" | "completed" | "failed";

export interface WorkflowAgentRecord {
  callIndex: number;
  label: string;
  phase: string | null;
  status: "queued" | "running" | "done" | "error";
  detail?: string;
  durationMs?: number;
  totalTokens?: number;
}

interface WorkflowExecutionRecord {
  taskId: string;
  executionDir: string;
  outputFile: string;
  meta: WorkflowMeta;
  status: WorkflowExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  phases: string[];
  agents: Map<number, WorkflowAgentRecord>;
  logs: string[];
}

export interface WorkflowExecutionSnapshot {
  taskId: string;
  executionDir: string;
  outputFile: string;
  name: string;
  description: string;
  status: WorkflowExecutionStatus;
  error?: string;
  finishedAt?: number;
  /** Wall-clock so far (running) or total (finished). */
  durationMs: number;
  agentsTotal: number;
  agentsDone: number;
  agentsFailed: number;
  agentsRunning: number;
  totalTokens: number;
  phases: Array<{ title: string; agents: WorkflowAgentRecord[] }>;
  logs: string[];
}

const runs = new Map<string, WorkflowExecutionRecord>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const FINISHED_RUN_RETENTION_MS = 5 * 60 * 1000;
const MAX_LOG_LINES = 50;

let version = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Coalesce change notifications to one per tick. The engine emits bursts
 * (every agent of a pipeline is queued in the same tick), and one forced
 * useSyncExternalStore re-render per event can exceed React's nested-update
 * limit under Ink ("Maximum update depth exceeded"; see #3964 for the same
 * failure in the mod registry). Readers see the latest state either way.
 */
function notify(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    version += 1;
    for (const listener of listeners) listener();
  }, 0);
  if (typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

/**
 * Monotonic change counter; a stable primitive for useSyncExternalStore so
 * UI subscribers re-render only when the registry actually changes.
 */
export function getWorkflowExecutionsVersion(): number {
  return version;
}

/** Subscribe to registry changes; returns an unsubscribe function. */
export function subscribeToWorkflowExecutions(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerWorkflowExecution(params: {
  taskId: string;
  executionDir: string;
  outputFile: string;
  meta: WorkflowMeta;
  startedAt?: number;
}): void {
  const existingTimer = cleanupTimers.get(params.taskId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    cleanupTimers.delete(params.taskId);
  }
  runs.set(params.taskId, {
    taskId: params.taskId,
    executionDir: params.executionDir,
    outputFile: params.outputFile,
    meta: params.meta,
    status: "running",
    startedAt: params.startedAt ?? Date.now(),
    phases: (params.meta.phases ?? []).map((p) => p.title),
    agents: new Map(),
    logs: [],
  });
  notify();
}

/** Apply one engine progress event to a run. */
export function recordWorkflowProgress(
  taskId: string,
  event: WorkflowProgressEvent,
): void {
  const record = runs.get(taskId);
  if (!record) return;
  switch (event.kind) {
    case "phase":
      if (!record.phases.includes(event.title)) record.phases.push(event.title);
      break;
    case "log":
      record.logs.push(event.message);
      if (record.logs.length > MAX_LOG_LINES) record.logs.shift();
      break;
    case "agent": {
      const previous = record.agents.get(event.callIndex);
      const phase = event.phase ?? previous?.phase ?? null;
      if (phase && !record.phases.includes(phase)) record.phases.push(phase);
      record.agents.set(event.callIndex, {
        callIndex: event.callIndex,
        label: event.label,
        phase,
        status: event.status,
        detail: event.detail,
        durationMs: event.durationMs ?? previous?.durationMs,
        // Cumulative per agent: a running event carries usage so far, the
        // terminal event the final figure.
        totalTokens: event.totalTokens ?? previous?.totalTokens,
      });
      break;
    }
  }
  notify();
}

export function finishWorkflowExecution(
  taskId: string,
  outcome: { status: "completed" | "failed"; error?: string },
): void {
  const record = runs.get(taskId);
  if (!record) return;
  record.status = outcome.status;
  record.error = outcome.error;
  record.finishedAt = Date.now();
  // Anything still marked queued/running never reported back (aborted).
  for (const agent of record.agents.values()) {
    if (agent.status === "queued" || agent.status === "running") {
      agent.status = "error";
      agent.detail = agent.detail ?? "interrupted";
    }
  }
  const timer = setTimeout(() => {
    cleanupTimers.delete(taskId);
    if (runs.get(taskId) === record) {
      runs.delete(taskId);
      notify();
    }
  }, FINISHED_RUN_RETENTION_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  cleanupTimers.set(taskId, timer);
  notify();
}

function snapshot(
  record: WorkflowExecutionRecord,
  now: number,
): WorkflowExecutionSnapshot {
  const agents = [...record.agents.values()].sort(
    (a, b) => a.callIndex - b.callIndex,
  );
  const byPhase = new Map<string, WorkflowAgentRecord[]>();
  const phaseOrder = [...record.phases];
  for (const agent of agents) {
    const title = agent.phase ?? "(no phase)";
    if (!byPhase.has(title)) {
      byPhase.set(title, []);
      if (!phaseOrder.includes(title)) phaseOrder.push(title);
    }
    byPhase.get(title)?.push(agent);
  }
  return {
    taskId: record.taskId,
    executionDir: record.executionDir,
    outputFile: record.outputFile,
    name: record.meta.name,
    description: record.meta.description,
    status: record.status,
    error: record.error,
    finishedAt: record.finishedAt,
    durationMs: Math.max(0, (record.finishedAt ?? now) - record.startedAt),
    agentsTotal: agents.length,
    agentsDone: agents.filter((a) => a.status === "done").length,
    agentsFailed: agents.filter((a) => a.status === "error").length,
    agentsRunning: agents.filter((a) => a.status === "running").length,
    totalTokens: agents.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0),
    phases: phaseOrder.map((title) => ({
      title,
      agents: byPhase.get(title) ?? [],
    })),
    logs: [...record.logs],
  };
}

export function getWorkflowExecution(
  taskId: string,
): WorkflowExecutionSnapshot | null {
  const record = runs.get(taskId);
  return record ? snapshot(record, Date.now()) : null;
}

/** All retained runs, oldest first. */
export function listWorkflowExecutions(): WorkflowExecutionSnapshot[] {
  const now = Date.now();
  return [...runs.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((record) => snapshot(record, now));
}

export function __resetWorkflowExecutionsForTests(): void {
  for (const timer of cleanupTimers.values()) clearTimeout(timer);
  cleanupTimers.clear();
  runs.clear();
  listeners.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  version = 0;
}
