/**
 * Workflow tool: launches a workflow script that orchestrates multiple
 * subagents deterministically. The engine lives in @/tools/workflow; each
 * agent() call in the script runs in an agent-free ephemeral conversation via
 * @letta-ai/letta-agent-sdk (loaded lazily — see @/tools/workflow/sdk-loader).
 *
 * The run happens in the background: the tool validates the script, registers
 * a background task, and returns at once with the task id. Progress streams
 * into the run registry (for the TUI status row, /workflows, and the tool-call
 * summary) and into the task's output file (for TaskOutput). Completion queues
 * a task notification through the message-queue bridge, exactly like
 * background Bash, Monitor, and background subagents, so all three host paths
 * (TUI, headless, listener) wake the model the same way.
 *
 * Listed in STREAMING_SHELL_TOOLS, so `signal`, `onOutput`, and `parentScope`
 * are injected into args (not part of the model-facing JSON schema).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConversationId } from "@/agent/context";
import { getPrimaryAgentModelHandle } from "@/agent/subagents/subagent-model";
import { resolveBackendMode } from "@/backend/backend-mode";
import {
  finishWorkflowExecution,
  recordWorkflowProgress,
  registerWorkflowExecution,
} from "@/tools/workflow/execution-registry";
import {
  formatWorkflowDuration,
  formatWorkflowSummary,
} from "@/tools/workflow/format-stats";
import { defaultExecutionsDir, newExecutionId } from "@/tools/workflow/journal";
import { parseWorkflowMeta } from "@/tools/workflow/meta";
import { loadAgentSdk } from "@/tools/workflow/sdk-loader";
import { SdkSubagentPool } from "@/tools/workflow/sdk-spawner";
import type {
  SubagentSpawner,
  WorkflowExecutionResult,
  WorkflowMeta,
  WorkflowProgressEvent,
} from "@/tools/workflow/types";
import { runWorkflow } from "@/tools/workflow/workflow-runner";
import { addToMessageQueue } from "@/utils/message-queue-bridge";
import {
  formatTaskNotification,
  resolveNotificationScope,
} from "@/utils/task-notifications";
import {
  appendBackgroundProcessOutput,
  appendToOutputFile,
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextWorkflowId,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "./process_manager.js";

interface WorkflowArgs {
  script?: string;
  scriptPath?: string;
  args?: unknown;
  budgetUsd?: number;
  resumeFromExecutionId?: string;
  model?: string;
  allowedTools?: string[];
  // Injected by the tool manager; not in the JSON schema.
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  parentScope?: { agentId: string; conversationId: string };
}

interface WorkflowResult {
  toolReturn: string;
  status: "success" | "error";
}

/** What the tool needs from a subagent backend; the SDK pool in production. */
export interface WorkflowSpawnerHandle {
  spawner: SubagentSpawner;
  cleanup(): Promise<void>;
}

type SpawnerFactory = (args: WorkflowArgs) => Promise<WorkflowSpawnerHandle>;

const MAX_NOTIFICATION_RESULT_CHARS = 30_000;

async function createSdkSpawner(
  args: WorkflowArgs,
): Promise<WorkflowSpawnerHandle> {
  const sdk = await loadAgentSdk();
  const parentModel = args.model
    ? args.model
    : (
        await getPrimaryAgentModelHandle({
          conversationId: getConversationId(),
        })
      ).handle;
  const client = sdk.createClient("local");
  const pool = new SdkSubagentPool(client, {
    cwd: process.cwd(),
    ...(parentModel ? { model: parentModel } : {}),
    ...(Array.isArray(args.allowedTools) && args.allowedTools.length > 0
      ? { allowedTools: args.allowedTools }
      : {}),
  });
  return { spawner: pool.spawner, cleanup: () => pool.cleanup() };
}

let spawnerFactory: SpawnerFactory = createSdkSpawner;

/** Swap the subagent backend (tests inject a fake spawner). */
export function __setWorkflowSpawnerFactoryForTests(
  factory: SpawnerFactory | null,
): void {
  spawnerFactory = factory ?? createSdkSpawner;
}

export function formatWorkflowProgressLine(
  event: WorkflowProgressEvent,
): string | null {
  switch (event.kind) {
    case "phase":
      return `── ${event.title} ──`;
    case "log":
      return `» ${event.message}`;
    case "agent": {
      // Only status transitions worth a line; "queued" would be noise.
      if (event.status === "queued") return null;
      const icon =
        event.status === "running"
          ? "▶"
          : event.status === "done"
            ? "✓"
            : event.status === "cached"
              ? "⟳"
              : "✗";
      const suffix = event.detail ? ` — ${event.detail}` : "";
      return `${icon} ${event.label}${suffix}`;
    }
  }
}

function truncateResult(text: string): string {
  if (text.length <= MAX_NOTIFICATION_RESULT_CHARS) return text;
  const notice =
    "\n\n[Workflow result truncated. Read the run's journal.jsonl or the task output file for the full value.]";
  return `${text.slice(0, MAX_NOTIFICATION_RESULT_CHARS - notice.length)}${notice}`;
}

function formatLaunchMessage(params: {
  taskId: string;
  executionId: string;
  executionDir: string;
  scriptPath: string;
  meta: WorkflowMeta;
}): string {
  const { taskId, executionId, executionDir, scriptPath, meta } = params;
  return [
    `Workflow launched in background. Task ID: ${taskId}`,
    `Summary: ${meta.description}`,
    `Execution ID: ${executionId}`,
    `Execution dir: ${executionDir}`,
    `Script file: ${scriptPath}`,
    `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${scriptPath}"} to iterate without resending the script.)`,
    `To resume after editing the script: Workflow({scriptPath: "${scriptPath}", resumeFromExecutionId: "${executionId}"}) — agents whose (prompt, opts) are unchanged replay from the journal.`,
    "",
    "You will be notified when it completes. Do not poll or sleep — keep working or end your turn. Use /workflows to watch live progress; TaskOutput reads the progress log; TaskStop aborts the run.",
  ].join("\n");
}

/**
 * Scripts can return anything (BigInt, circular graphs, functions); the
 * notification must never throw over it.
 */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value) ?? "null");
  } catch {
    return String(value);
  }
}

function formatCompletionResult(run: WorkflowExecutionResult): string {
  const payload = JSON.stringify(
    {
      executionId: run.executionId,
      executionDir: run.executionDir,
      result: jsonSafe(run.result),
      agentsSpawned: run.agentsSpawned,
      cacheHits: run.cacheHits,
      totalCostUsd: Number(run.totalCostUsd.toFixed(4)),
      totalTokens: run.totalTokens,
    },
    null,
    2,
  );
  const diagnostics = [
    `Per-agent results: ${join(run.executionDir, "journal.jsonl")} — one {"kind":"agent",...} line per completed agent with its full return value.`,
    "If the result above is empty or unexpected, read that file BEFORE diagnosing — do not assume agents returned non-empty results.",
    `To re-run with edited post-processing: Workflow({scriptPath: "${join(run.executionDir, "script.js")}", resumeFromExecutionId: "${run.executionId}"}) — unchanged agents replay from cache.`,
  ].join("\n");
  return truncateResult(`${payload}\n\n${diagnostics}`);
}

function queueCompletion(params: {
  taskId: string;
  meta: WorkflowMeta;
  processState: BackgroundProcess;
  outputFile: string;
  scope: ReturnType<typeof resolveNotificationScope>;
  run?: WorkflowExecutionResult;
  error?: string;
}): void {
  const { taskId, meta, processState, outputFile, scope, run, error } = params;
  if (processState.completionNotificationSuppressed) return;
  const durationMs = processState.startTime
    ? Math.max(0, Date.now() - processState.startTime.getTime())
    : undefined;
  const status = run ? "completed" : "failed";
  // The summary is what the transcript shows for the notification, so it
  // carries the same numbers as the live status row.
  const summary = run
    ? `Workflow "${meta.description}" completed · ${formatWorkflowSummary({
        durationMs: durationMs ?? 0,
        agentsDone: run.agentsSpawned + run.cacheHits,
        agentsTotal: run.agentsSpawned + run.cacheHits,
        totalTokens: run.totalTokens,
      })}`
    : `Workflow "${meta.description}" failed${
        durationMs === undefined
          ? ""
          : ` after ${formatWorkflowDuration(durationMs)}`
      }`;
  addToMessageQueue({
    kind: "task_notification",
    text: formatTaskNotification({
      taskId,
      status,
      summary,
      result: run
        ? formatCompletionResult(run)
        : `Workflow failed: ${error ?? "unknown error"}`,
      outputFile,
      usage: {
        ...(run ? { totalTokens: run.totalTokens } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    }),
    agentId: scope?.agentId,
    conversationId: scope?.conversationId,
  });
}

export async function workflow(args: WorkflowArgs): Promise<WorkflowResult> {
  let script = typeof args.script === "string" ? args.script : undefined;
  if (typeof args.scriptPath === "string" && args.scriptPath) {
    try {
      script = readFileSync(args.scriptPath, "utf8");
    } catch (error) {
      return {
        toolReturn: `Cannot read scriptPath ${args.scriptPath}: ${String(error)}`,
        status: "error",
      };
    }
  }
  if (!script) {
    return {
      toolReturn: "Provide `script` (inline source) or `scriptPath`.",
      status: "error",
    };
  }
  if (resolveBackendMode() !== "api") {
    return {
      toolReturn:
        "Workflow agent() calls require the API backend because agent-free conversations are not supported by the local store.",
      status: "error",
    };
  }

  // Validate up front so authoring mistakes surface in the tool result
  // instead of as a failed background task.
  let meta: WorkflowMeta;
  try {
    meta = parseWorkflowMeta(script);
  } catch (error) {
    return {
      toolReturn: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }

  let handle: WorkflowSpawnerHandle;
  try {
    assertBackgroundProcessCapacity();
    handle = await spawnerFactory(args);
  } catch (error) {
    return {
      toolReturn: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }

  const taskId = getNextWorkflowId();
  const executionId = newExecutionId();
  const executionsDir = defaultExecutionsDir();
  const executionDir = join(executionsDir, executionId);
  const scriptPath = join(executionDir, "script.js");
  const outputFile = createBackgroundOutputFile(taskId);
  const scope = resolveNotificationScope(args.parentScope);
  const abortController = new AbortController();

  const processState: BackgroundProcess = {
    process: {
      kill() {
        abortController.abort(new Error("Workflow stopped via TaskStop"));
      },
    },
    command: `workflow ${meta.name}`,
    stdout: [],
    stderr: [],
    status: "running",
    exitCode: null,
    lastReadIndex: { stdout: 0, stderr: 0 },
    startTime: new Date(),
    outputFile,
    totalStdoutLines: 0,
    totalStderrLines: 0,
    runtimeScope: scope,
    kind: "workflow",
    description: meta.description,
  };
  backgroundProcesses.set(taskId, processState);
  registerWorkflowExecution({
    taskId,
    executionId,
    executionDir,
    scriptPath,
    outputFile,
    meta,
    startedAt: processState.startTime?.getTime(),
  });
  notifyBackgroundProcessStateChanged(scope);

  const finish = (outcome: {
    run?: WorkflowExecutionResult;
    error?: string;
  }) => {
    if (backgroundProcesses.get(taskId) !== processState) return;
    // A TaskStop already marked the entry failed and suppressed notification.
    if (processState.status === "running") {
      processState.status = outcome.run ? "completed" : "failed";
      processState.exitCode = outcome.run ? 0 : 1;
    }
    if (outcome.run) {
      appendToOutputFile(
        outputFile,
        `\n[result]\n${formatCompletionResult(outcome.run)}\n`,
      );
    } else {
      appendToOutputFile(outputFile, `\n[error] ${outcome.error}\n`);
    }
    finishWorkflowExecution(taskId, {
      status: processState.status === "completed" ? "completed" : "failed",
      error: outcome.error,
    });
    notifyBackgroundProcessStateChanged(scope);
    scheduleBackgroundProcessCleanup(taskId);
    queueCompletion({
      taskId,
      meta,
      processState,
      outputFile,
      scope,
      run: outcome.run,
      error: outcome.error,
    });
  };

  // Runs detached from this tool call; the abort signal of the *call* is
  // deliberately not wired in — interrupting the turn must not kill a run the
  // model was told would continue in the background. TaskStop aborts it.
  void runWorkflow(handle.spawner, {
    script,
    args: args.args,
    executionId,
    executionsDir,
    budgetUsd: typeof args.budgetUsd === "number" ? args.budgetUsd : undefined,
    resumeFromExecutionId:
      typeof args.resumeFromExecutionId === "string" &&
      args.resumeFromExecutionId
        ? args.resumeFromExecutionId
        : undefined,
    signal: abortController.signal,
    onProgress: (event) => {
      recordWorkflowProgress(taskId, event);
      const line = formatWorkflowProgressLine(event);
      if (!line) return;
      appendBackgroundProcessOutput(processState, "stdout", line);
      appendToOutputFile(outputFile, `${line}\n`);
    },
  })
    .then(
      (run) => finish({ run }),
      (error: unknown) =>
        finish({
          error: abortController.signal.aborted
            ? "Workflow stopped"
            : error instanceof Error
              ? error.message
              : String(error),
        }),
    )
    .catch((error: unknown) => {
      // finish() itself failed (e.g. the output file vanished). Never let a
      // background run surface as an unhandled rejection.
      appendToOutputFile(outputFile, `\n[error] ${String(error)}\n`);
    })
    .finally(() => handle.cleanup().catch(() => {}));

  return {
    toolReturn: formatLaunchMessage({
      taskId,
      executionId,
      executionDir,
      scriptPath,
      meta,
    }),
    status: "success",
  };
}
