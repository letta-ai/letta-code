/**
 * Workflow tool: launches a workflow script that orchestrates multiple
 * subagents deterministically. The engine lives in @/tools/workflow; each
 * agent() call in the script runs in an agent-free ephemeral conversation via
 * @letta-ai/letta-agent-sdk (loaded lazily — see @/tools/workflow/sdk-loader).
 *
 * The run happens in the background: the tool validates the script, registers
 * a background task, and returns at once with the task id. Progress lines go
 * to the task's output file. Completion queues a task
 * notification through the message-queue bridge, exactly like background
 * Bash, Monitor, and background subagents, so all three host paths (TUI,
 * headless, listener) wake the model the same way.
 *
 * Listed in STREAMING_SHELL_TOOLS, so `signal`, `onOutput`, and `parentScope`
 * are injected into args (not part of the model-facing JSON schema).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { resolveModel } from "@/agent/model-catalog";
import { getPrimaryAgentModelHandle } from "@/agent/subagents/subagent-model";
import { apiRequest } from "@/backend/api/request";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import {
  finishWorkflowExecution,
  recordWorkflowProgress,
  registerWorkflowExecution,
} from "@/tools/workflow/execution-registry";
import {
  formatWorkflowDuration,
  formatWorkflowSummary,
} from "@/tools/workflow/format-stats";
import {
  createExecutionDir,
  defaultExecutionsDir,
  newExecutionId,
} from "@/tools/workflow/journal";
import { parseWorkflowMeta } from "@/tools/workflow/meta";
import { loadAgentSdk } from "@/tools/workflow/sdk-loader";
import {
  createSdkSpawner,
  DEFAULT_ALLOWED_TOOLS,
} from "@/tools/workflow/sdk-spawner";
import type {
  SubagentSpawner,
  WorkflowExecutionResult,
  WorkflowMeta,
  WorkflowProgressEvent,
} from "@/tools/workflow/types";
import {
  DEFAULT_MAX_CONCURRENT,
  executeWorkflow,
} from "@/tools/workflow/workflow-engine";
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
  maxConcurrent?: number;
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

/** What the tool needs from a subagent backend; the SDK spawner in production. */
export interface WorkflowSpawnerHandle {
  spawner: SubagentSpawner;
  cleanup(): Promise<void>;
}

type SpawnerFactory = (args: WorkflowArgs) => Promise<WorkflowSpawnerHandle>;

const MAX_NOTIFICATION_RESULT_CHARS = 30_000;

async function resolveParentAgentId(
  args: WorkflowArgs,
): Promise<string | null> {
  let parentAgentId: string | null | undefined = args.parentScope?.agentId;
  const conversationId =
    args.parentScope?.conversationId ?? getConversationId();
  if (!parentAgentId?.startsWith("agent-")) {
    if (conversationId && conversationId !== "default") {
      // The invoking conversation may itself be agent-free (a worker of an
      // outer workflow); its parent supplies the lineage then.
      const conversation = await apiRequest<{
        agent_id: string | null;
        parent_agent_id?: string | null;
      }>("GET", `/v1/conversations/${encodeURIComponent(conversationId)}`);
      parentAgentId =
        conversation.agent_id ?? conversation.parent_agent_id ?? null;
    } else {
      parentAgentId = getCurrentAgentId();
    }
  }
  return parentAgentId?.startsWith("agent-") ? parentAgentId : null;
}

export async function createSdkSpawnerHandle(
  args: WorkflowArgs,
): Promise<WorkflowSpawnerHandle> {
  const parentAgentId = await resolveParentAgentId(args);
  if (!parentAgentId) {
    throw new Error("Workflow requires an invoking parent agent.");
  }
  let model: string | null;
  if (args.model) {
    model = resolveModel(args.model);
    if (!model) {
      throw new Error(
        `Unknown model "${args.model}". Run \`letta model list\` for valid handles.`,
      );
    }
  } else {
    model = (
      await getPrimaryAgentModelHandle({
        agentId: parentAgentId,
        conversationId: args.parentScope?.conversationId ?? getConversationId(),
      })
    ).handle;
    if (!model) {
      throw new Error(
        "Could not resolve the invoking conversation's model; pass `model` explicitly.",
      );
    }
  }
  const sdk = await loadAgentSdk();
  const client = sdk.createLocalClient();
  return {
    spawner: createSdkSpawner(client, {
      parentAgentId,
      model,
      resolveModel,
      allowedTools: args.allowedTools ?? [...DEFAULT_ALLOWED_TOOLS],
      cwd: getCurrentWorkingDirectory(),
    }),
    cleanup: async () => {
      await client[Symbol.asyncDispose]?.().catch(() => undefined);
    },
  };
}

let spawnerFactory: SpawnerFactory = createSdkSpawnerHandle;

/** Swap the subagent backend (tests inject a fake spawner). */
export function __setWorkflowSpawnerFactoryForTests(
  factory: SpawnerFactory | null,
): void {
  spawnerFactory = factory ?? createSdkSpawnerHandle;
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
        event.status === "running" ? "▶" : event.status === "done" ? "✓" : "✗";
      const suffix = event.detail ? ` — ${event.detail}` : "";
      return `${icon} ${event.label}${suffix}`;
    }
  }
}

function truncateResult(text: string): string {
  if (text.length <= MAX_NOTIFICATION_RESULT_CHARS) return text;
  const notice =
    "\n\n[Workflow result truncated. Read the task output file for the full value.]";
  return `${text.slice(0, MAX_NOTIFICATION_RESULT_CHARS - notice.length)}${notice}`;
}

/**
 * Models routinely pass `args` as a JSON-encoded string despite the schema
 * asking for a real value, and the script then dies on `args.files.length`.
 * A string that is itself a JSON object or array is unambiguous: decode it.
 * Any other string stays a string.
 */
export function normalizeWorkflowArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
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

function formatCompletionResult(
  run: WorkflowExecutionResult,
  executionDir: string,
): string {
  const payload = JSON.stringify(
    {
      result: jsonSafe(run.result),
      agentsSpawned: run.agentsSpawned,
      totalTokens: run.totalTokens,
    },
    null,
    2,
  );
  return [
    payload,
    "",
    `Per-agent results: ${join(executionDir, "journal.jsonl")} — one line per completed agent with its full return value.`,
    "If the result above is empty or unexpected, read that file BEFORE diagnosing — do not assume agents returned non-empty results.",
  ].join("\n");
}

export async function workflow(args: WorkflowArgs): Promise<WorkflowResult> {
  let script = typeof args.script === "string" ? args.script : undefined;
  if (typeof args.scriptPath === "string" && args.scriptPath) {
    try {
      script = readFileSync(
        resolve(getCurrentWorkingDirectory(), args.scriptPath),
        "utf8",
      );
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
  if (
    args.maxConcurrent !== undefined &&
    (!Number.isInteger(args.maxConcurrent) || args.maxConcurrent < 1)
  ) {
    return {
      toolReturn: "maxConcurrent must be a positive integer.",
      status: "error",
    };
  }

  // Validate up front so authoring mistakes surface in the tool result
  // instead of as a failed background task.
  let meta: WorkflowMeta;
  let handle: WorkflowSpawnerHandle;
  try {
    meta = parseWorkflowMeta(script);
    assertBackgroundProcessCapacity();
    handle = await spawnerFactory(args);
  } catch (error) {
    return {
      toolReturn: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }

  const taskId = getNextWorkflowId();
  const scriptArgs = normalizeWorkflowArgs(args.args);
  const { executionDir, scriptPath, journalPath } = createExecutionDir(
    defaultExecutionsDir(),
    newExecutionId(),
    script,
    scriptArgs,
  );
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
    executionDir,
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
    const result = outcome.run
      ? formatCompletionResult(outcome.run, executionDir)
      : `Workflow failed: ${outcome.error ?? "unknown error"}`;
    appendToOutputFile(
      outputFile,
      outcome.run ? `\n[result]\n${result}\n` : `\n[error] ${outcome.error}\n`,
    );
    finishWorkflowExecution(taskId, {
      status: processState.status === "completed" ? "completed" : "failed",
      error: outcome.error,
    });
    notifyBackgroundProcessStateChanged(scope);
    scheduleBackgroundProcessCleanup(taskId);
    if (processState.completionNotificationSuppressed) return;
    const durationMs = Date.now() - (processState.startTime?.getTime() ?? 0);
    // The summary is what the transcript shows for the notification, so it
    // carries the same numbers as /workflows.
    const summary = outcome.run
      ? `Workflow "${meta.description}" completed · ${formatWorkflowSummary({
          durationMs,
          agentsDone: outcome.run.agentsSpawned,
          agentsTotal: outcome.run.agentsSpawned,
          totalTokens: outcome.run.totalTokens,
        })}`
      : `Workflow "${meta.description}" failed after ${formatWorkflowDuration(durationMs)}`;
    addToMessageQueue({
      kind: "task_notification",
      text: formatTaskNotification({
        taskId,
        status: outcome.run ? "completed" : "failed",
        summary,
        result: truncateResult(result),
        outputFile,
        usage: {
          durationMs,
          ...(outcome.run ? { totalTokens: outcome.run.totalTokens } : {}),
        },
      }),
      agentId: scope?.agentId,
      conversationId: scope?.conversationId,
      actingUserId: scope?.actingUserId,
    });
  };

  // Runs detached from this tool call; the abort signal of the *call* is
  // deliberately not wired in — interrupting the turn must not kill a run the
  // model was told would continue in the background. TaskStop aborts it.
  void executeWorkflow(handle.spawner, {
    script,
    args: scriptArgs,
    maxConcurrent: args.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    journalPath,
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
    toolReturn: [
      `Workflow launched in background. Task ID: ${taskId}`,
      `Summary: ${meta.description}`,
      `Script file: ${scriptPath}`,
      `Journal: ${journalPath} (one line per completed agent)`,
      `Output file: ${outputFile}`,
      "",
      "You will be notified when it completes. Do not poll or sleep — keep working or end your turn. Read the output file only when you need interim progress; TaskStop aborts the run; the user can watch live status with /workflows.",
    ].join("\n"),
    status: "success",
  };
}
