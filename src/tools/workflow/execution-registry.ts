/**
 * In-process registry of Workflow tool runs, kept for live monitoring.
 *
 * The Workflow tool launches a run in the background and returns at once; the
 * run then reports progress here. The TUI status row, the /workflows view,
 * and the tool-call summary line all read from this registry and subscribe to
 * change notifications, so nothing polls. Entries for finished runs are
 * retained for a short while so the UI can show the final summary.
 */

import type { WorkflowMeta, WorkflowProgressEvent } from "./types.ts";

export type WorkflowExecutionStatus = "running" | "completed" | "failed";

export type WorkflowAgentStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cached";

export interface WorkflowAgentRecord {
  callIndex: number;
  label: string;
  phase: string | null;
  status: WorkflowAgentStatus;
  detail?: string;
  durationMs?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface WorkflowExecutionRecord {
  /** Background task id (`workflow_N`); what TaskOutput/TaskStop accept. */
  taskId: string;
  /** Journal run id (`wf-…`); what resumeFromExecutionId accepts. */
  executionId: string;
  executionDir: string;
  scriptPath: string;
  outputFile: string;
  meta: WorkflowMeta;
  status: WorkflowExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  phases: string[];
  agents: Map<number, WorkflowAgentRecord>;
  logs: string[];
  totalTokens: number;
  totalCostUsd: number;
  cacheHits: number;
}

export interface WorkflowExecutionSnapshot {
  taskId: string;
  executionId: string;
  executionDir: string;
  scriptPath: string;
  outputFile: string;
  name: string;
  description: string;
  status: WorkflowExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Wall-clock so far (running) or total (finished). */
  durationMs: number;
  agentsTotal: number;
  agentsDone: number;
  agentsFailed: number;
  agentsRunning: number;
  cacheHits: number;
  totalTokens: number;
  totalCostUsd: number;
  phases: Array<{
    title: string;
    agents: WorkflowAgentRecord[];
  }>;
  logs: string[];
}

type Listener = () => void;

const runs = new Map<string, WorkflowExecutionRecord>();
const listeners = new Set<Listener>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

const FINISHED_RUN_RETENTION_MS = 5 * 60 * 1000;
const MAX_LOG_LINES = 50;

let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Monotonic change counter; a stable primitive for useSyncExternalStore so UI
 * subscribers re-render only when the registry actually changes.
 */
export function getWorkflowExecutionsVersion(): number {
  return version;
}

/** Subscribe to registry changes; returns an unsubscribe function. */
export function subscribeToWorkflowExecutions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerWorkflowExecution(params: {
  taskId: string;
  executionId: string;
  executionDir: string;
  scriptPath: string;
  outputFile: string;
  meta: WorkflowMeta;
  startedAt?: number;
}): WorkflowExecutionRecord {
  const record: WorkflowExecutionRecord = {
    taskId: params.taskId,
    executionId: params.executionId,
    executionDir: params.executionDir,
    scriptPath: params.scriptPath,
    outputFile: params.outputFile,
    meta: params.meta,
    status: "running",
    startedAt: params.startedAt ?? Date.now(),
    phases: (params.meta.phases ?? []).map((p) => p.title),
    agents: new Map(),
    logs: [],
    totalTokens: 0,
    totalCostUsd: 0,
    cacheHits: 0,
  };
  const existingTimer = cleanupTimers.get(params.taskId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    cleanupTimers.delete(params.taskId);
  }
  runs.set(params.taskId, record);
  notify();
  return record;
}

/** Apply one engine progress event to a run and notify subscribers. */
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
        totalTokens: event.totalTokens ?? previous?.totalTokens,
        costUsd: event.costUsd ?? previous?.costUsd,
      });
      if (event.status === "cached") record.cacheHits += 1;
      if (event.status === "done" || event.status === "error") {
        record.totalTokens += event.totalTokens ?? 0;
        record.totalCostUsd += event.costUsd ?? 0;
      }
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

export function snapshotWorkflowExecution(
  record: WorkflowExecutionRecord,
  now = Date.now(),
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
    executionId: record.executionId,
    executionDir: record.executionDir,
    scriptPath: record.scriptPath,
    outputFile: record.outputFile,
    name: record.meta.name,
    description: record.meta.description,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    durationMs: Math.max(0, (record.finishedAt ?? now) - record.startedAt),
    agentsTotal: agents.length,
    agentsDone: agents.filter(
      (a) => a.status === "done" || a.status === "cached",
    ).length,
    agentsFailed: agents.filter((a) => a.status === "error").length,
    agentsRunning: agents.filter((a) => a.status === "running").length,
    cacheHits: record.cacheHits,
    totalTokens: record.totalTokens,
    totalCostUsd: record.totalCostUsd,
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
  return record ? snapshotWorkflowExecution(record) : null;
}

/** All retained runs, oldest first. */
export function listWorkflowExecutions(): WorkflowExecutionSnapshot[] {
  const now = Date.now();
  return [...runs.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((record) => snapshotWorkflowExecution(record, now));
}

export function countRunningWorkflowExecutions(): number {
  let count = 0;
  for (const record of runs.values()) {
    if (record.status === "running") count += 1;
  }
  return count;
}

export function __resetWorkflowExecutionsForTests(): void {
  for (const timer of cleanupTimers.values()) clearTimeout(timer);
  cleanupTimers.clear();
  runs.clear();
  listeners.clear();
  version = 0;
}
