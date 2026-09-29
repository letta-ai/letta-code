import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { getCommittedMemfsRevision } from "@/backend/local/system-prompt-compilation";
import {
  listWorkflowExecutions,
  subscribeToWorkflowExecutions,
  type WorkflowExecutionSnapshot,
} from "@/tools/workflow/execution-registry";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";

const MAX_WAIT_MS = 30 * 60 * 1000;
const MAX_FOLLOW_UPS = 4;

export interface ImportInitState {
  manifestDir: string;
  expectedSessions: number;
  memoryDir: string;
  initialRevision?: string;
  handled: Set<string>;
  workflowRuns: WorkflowExecutionSnapshot[];
  followUps: number;
  startedAt: number;
}

export function importInitState(
  raw: string | undefined,
  agentId: string,
): ImportInitState | null {
  if (!raw) return null;
  const input = JSON.parse(raw) as Record<string, unknown>;
  if (
    input.agentId !== agentId ||
    typeof input.manifestDir !== "string" ||
    !Number.isSafeInteger(input.expectedSessions) ||
    (input.expectedSessions as number) < 1
  ) {
    throw new Error("Invalid import init wait scope");
  }
  const memoryDir = getLocalBackendMemoryFilesystemRoot(
    agentId,
    getLocalBackendStorageDir(),
  );
  return {
    manifestDir: input.manifestDir,
    expectedSessions: input.expectedSessions as number,
    memoryDir,
    initialRevision: getCommittedMemfsRevision(memoryDir),
    handled: new Set(),
    workflowRuns: [],
    followUps: 0,
    startedAt: Date.now(),
  };
}

function newRuns(state: ImportInitState): WorkflowExecutionSnapshot[] {
  return listWorkflowExecutions().filter(
    (run) => !state.handled.has(run.taskId),
  );
}

function waitForChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const stop = subscribeToWorkflowExecutions(() => {
      clearTimeout(timer);
      stop();
      resolve();
    });
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, ms);
  });
}

/** Continue the same headless conversation after the background Workflow ends.
 * A successful foreground assistant reply is not a workflow completion signal.
 */
export async function importInitWaitForWorkflows(
  state: ImportInitState,
): Promise<string | null> {
  let pending = newRuns(state);
  if (pending.length === 0) {
    if (state.workflowRuns.length === 0) {
      throw new Error("No dynamic Workflow was started by the init turn");
    }
    return null;
  }
  if (state.followUps >= MAX_FOLLOW_UPS) {
    throw new Error("Too many import init Workflow follow-up turns");
  }
  while (pending.some((run) => run.status === "running")) {
    if (Date.now() - state.startedAt > MAX_WAIT_MS) {
      throw new Error(
        "Import init Workflow timed out; history remains imported",
      );
    }
    await waitForChange(1000);
    pending = newRuns(state);
  }
  if (pending.some((run) => run.status !== "completed")) {
    throw new Error("Import init Workflow failed; history remains imported");
  }
  for (const run of pending) {
    state.handled.add(run.taskId);
    state.workflowRuns.push(run);
  }
  state.followUps += 1;
  return `<system-reminder>\nThe import analysis Workflow(s) finished: ${pending.map((run) => `${run.taskId}: ${run.agentsDone}/${run.agentsTotal} workers succeeded; journal ${join(run.executionDir, "journal.jsonl")}; output ${run.outputFile}`).join("\n")}. Read the actual journals and outputs, verify history coverage against ${join(state.manifestDir, "manifest.json")}, then synthesize evidence-backed memory in this agent's repository. If any cohort was unread, launch a follow-up read-only Workflow and account for it. Commit memory changes before claiming complete initialization. Do not ask questions.\n</system-reminder>`;
}

/** Refuse a false success after a headless turn that only announced a task. */
export function importInitVerify(state: ImportInitState): void {
  if (!state.workflowRuns.length) {
    throw new Error("No completed Workflow; memory initialization was not run");
  }
  const read = new Set<string>();
  let successfulWorkers = 0;
  for (const run of state.workflowRuns) {
    if (run.status !== "completed")
      throw new Error(`Workflow ${run.taskId} failed`);
    const path = join(run.executionDir, "journal.jsonl");
    if (!existsSync(path)) throw new Error(`Missing Workflow journal: ${path}`);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        outcome?: {
          failed?: boolean;
          conversationId?: string;
          value?: unknown;
        };
      };
      if (entry.outcome?.failed || !entry.outcome?.conversationId) continue;
      successfulWorkers += 1;
      const value = entry.outcome.value;
      if (
        value &&
        typeof value === "object" &&
        "sessionsRead" in value &&
        Array.isArray(value.sessionsRead)
      ) {
        for (const id of value.sessionsRead)
          if (typeof id === "string") read.add(id);
      }
    }
  }
  if (!successfulWorkers)
    throw new Error("No successful local Workflow workers");
  const manifest = JSON.parse(
    readFileSync(join(state.manifestDir, "manifest.json"), "utf8"),
  ) as {
    sessions?: Array<{ sessionId: string }>;
  };
  const expected = manifest.sessions ?? [];
  if (expected.length !== state.expectedSessions)
    throw new Error("Import manifest changed during initialization");
  const unread = expected.filter((session) => !read.has(session.sessionId));
  if (unread.length > 0) {
    throw new Error(
      `Workflow did not account for ${unread.length}/${expected.length} sessions`,
    );
  }
  const revision = getCommittedMemfsRevision(state.memoryDir);
  if (!revision || revision === state.initialRevision) {
    throw new Error(
      "Agent memory has no new committed initialization revision",
    );
  }
  const root = join(state.memoryDir, "MEMORY.md");
  if (!existsSync(root) || statSync(root).size === 0) {
    throw new Error("Agent memory is missing a non-empty root MEMORY.md");
  }
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: state.memoryDir,
    encoding: "utf8",
  });
  if (dirty.trim())
    throw new Error("Memory repository has uncommitted changes");
}
