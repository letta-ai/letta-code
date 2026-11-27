import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConversationId } from "@/agent/context";
import { resolveModel } from "@/agent/model-catalog";
import { getPrimaryAgentModelHandle } from "@/agent/subagents/subagent-model";
import { getBackend } from "@/backend";
import { resolveBackendMode } from "@/backend/backend-mode";
import { permissionMode } from "@/permissions/mode";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import {
  createScriptToolScope,
  resolveScriptParentAgentId,
} from "@/tools/script-tool-scope";
import {
  finishWorkflowExecution,
  getWorkflowExecution,
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
  type SdkSpawnerConfig,
} from "@/tools/workflow/sdk-spawner";
import type {
  SubagentSpawner,
  WorkflowExecutionResult,
  WorkflowMeta,
  WorkflowProgressEvent,
  WorkflowToolCaller,
  WorkflowToolInfo,
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
  maxCostUsd?: number;
  model?: string;
  allowedTools?: string[];
  wait?: boolean;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  parentScope?: { agentId: string; conversationId: string };
}

interface WorkflowResult {
  toolReturn: string;
  status: "success" | "error";
}

export interface WorkflowSpawnerHandle {
  spawner: SubagentSpawner;
  callTool?: WorkflowToolCaller;
  builtinToolNames?: readonly string[];
  listTools?: () => Promise<WorkflowToolInfo[]>;
  refresh?: () => Promise<void>;
  env?: Readonly<Record<string, string>>;
  backgroundStopController?: AbortController;
  cleanup(): Promise<void>;
}

type SpawnerFactory = (
  args: WorkflowArgs,
  setStage: (stage: string) => void,
) => Promise<WorkflowSpawnerHandle>;

const MAX_NOTIFICATION_RESULT_CHARS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
let startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;

async function captureInvokingContext(
  args: WorkflowArgs,
  parentAgentId: string,
  setStage: (stage: string) => void,
): Promise<Partial<SdkSpawnerConfig> & { model: string }> {
  setStage("resolving model");
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
  let parentModelSettings: Record<string, unknown> | undefined;
  let parentContextWindowLimit: number | null | undefined;
  if (resolveBackendMode() === "local") {
    setStage("snapshotting local parent settings");
    const conversationId =
      args.parentScope?.conversationId ?? getConversationId();
    const source =
      conversationId && conversationId !== "default"
        ? await getBackend().retrieveConversation(conversationId)
        : await getBackend().retrieveAgent(parentAgentId);
    const record = source as unknown as Record<string, unknown>;
    if (
      record.model_settings &&
      typeof record.model_settings === "object" &&
      !Array.isArray(record.model_settings)
    ) {
      parentModelSettings = { ...record.model_settings } as Record<
        string,
        unknown
      >;
    }
    if (
      typeof record.context_window_limit === "number" ||
      record.context_window_limit === null
    ) {
      parentContextWindowLimit = record.context_window_limit;
    }
  }
  const runtime = getRuntimeContext();
  const toolContextId = runtime?.toolContextId ?? null;
  const manager = await import("@/tools/manager");
  const executionContext = toolContextId
    ? manager.getExecutionContextById(toolContextId)
    : undefined;
  return {
    model,
    parentToolNames: runtime?.clientToolNames,
    agentScopedToolNames: Array.from(executionContext?.modTools.values() ?? [])
      .filter((tool) => tool.owner?.scope === "agent")
      .map((tool) => tool.name),
    permissionMode: runtime?.permissionMode ?? permissionMode.getMode(),
    cwd: getCurrentWorkingDirectory(),
    parentModelSettings,
    parentContextWindowLimit,
  };
}

export async function createSdkSpawnerHandle(
  args: WorkflowArgs,
  setStage: (stage: string) => void = () => {},
): Promise<WorkflowSpawnerHandle> {
  setStage("resolving parent agent");
  const parentAgentId = await resolveScriptParentAgentId(args);
  if (!parentAgentId) {
    throw new Error("Workflow requires an invoking parent agent.");
  }
  const config: SdkSpawnerConfig = {
    parentAgentId,
    resolveModel,
    allowedTools: args.allowedTools,
    verifyPersistedRuns: resolveBackendMode() === "api",
    ...(await captureInvokingContext(args, parentAgentId, setStage)),
  };
  setStage("loading Agent SDK");
  const sdk = await loadAgentSdk();
  setStage("creating SDK client and spawner");
  config.supportsAgentFreeResume = sdk.supportsAgentFreeResume;
  const client = sdk.createLocalClient(resolveBackendMode());
  let spawner: SubagentSpawner;
  try {
    spawner = createSdkSpawner(client, config);
  } catch (error) {
    void client[Symbol.asyncDispose]?.().catch(() => undefined);
    throw error;
  }
  const backgroundStopController = args.wait
    ? undefined
    : new AbortController();
  const toolScope = await createScriptToolScope(
    parentAgentId,
    args.wait ? args.signal : backgroundStopController?.signal,
  );
  return {
    spawner,
    ...toolScope,
    refresh: async () => {
      Object.assign(
        config,
        await captureInvokingContext(args, parentAgentId, () => {}),
      );
    },
    backgroundStopController,
    cleanup: async () => {
      await toolScope.cleanup();
      await client[Symbol.asyncDispose]?.().catch(() => undefined);
    },
  };
}

function toolOptions(handle: WorkflowSpawnerHandle) {
  return {
    ...(handle.callTool ? { callTool: handle.callTool } : {}),
    ...(handle.builtinToolNames
      ? { builtinToolNames: handle.builtinToolNames }
      : {}),
    ...(handle.listTools ? { listTools: handle.listTools } : {}),
    ...(handle.env ? { env: handle.env } : {}),
  };
}

let spawnerFactory: SpawnerFactory = createSdkSpawnerHandle;

export function __setWorkflowSpawnerFactoryForTests(
  factory: SpawnerFactory | null,
): void {
  spawnerFactory = factory ?? createSdkSpawnerHandle;
}

export function __setWorkflowStartupTimeoutForTests(
  timeoutMs: number | null,
): void {
  startupTimeoutMs = timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
}

export function formatWorkflowProgressLine(
  event: WorkflowProgressEvent,
): string | null {
  switch (event.kind) {
    case "phase":
      return `── ${event.title} ──`;
    case "log":
      return `» ${event.message}`;
    case "decision_usage":
      return null;
    case "agent": {
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

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value) ?? "null");
  } catch {
    return String(value);
  }
}

export function formatFailureResult(
  error: string | undefined,
  agentsDone: number,
  journalPath: string,
): string {
  const lines = [`Workflow failed: ${error ?? "unknown error"}`];
  if (agentsDone > 0) {
    lines.push(
      `${agentsDone} agent call${agentsDone === 1 ? "" : "s"} completed before the failure. Their full results are saved in ${journalPath} (one line per completed call; the return value is outcome.value).`,
    );
  }
  return lines.join("\n");
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
      ...(run.totalCostUsd !== null ? { totalCostUsd: run.totalCostUsd } : {}),
    },
    null,
    2,
  );
  return [
    payload,
    "",
    `Per-call results: ${join(executionDir, "journal.jsonl")} — one line per completed agent call with its full return value, plus one per decide() API attempt (retries included) with its model, cost, calibration, and tokens.`,
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
  if (
    args.maxConcurrent !== undefined &&
    (!Number.isInteger(args.maxConcurrent) || args.maxConcurrent < 1)
  ) {
    return {
      toolReturn: "maxConcurrent must be a positive integer.",
      status: "error",
    };
  }

  if (
    args.maxCostUsd !== undefined &&
    (typeof args.maxCostUsd !== "number" ||
      !Number.isFinite(args.maxCostUsd) ||
      args.maxCostUsd <= 0)
  ) {
    return {
      toolReturn: "maxCostUsd must be a positive number of US dollars.",
      status: "error",
    };
  }
  let meta: WorkflowMeta;
  try {
    meta = parseWorkflowMeta(script);
    assertBackgroundProcessCapacity();
  } catch (error) {
    return {
      toolReturn: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }

  let stage = "setting up spawner";
  let abandoned = false;
  let stopReason: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let disposalStarted = false;
  const disposeAbandonedHandle = (lateHandle: WorkflowSpawnerHandle) => {
    if (disposalStarted) return;
    disposalStarted = true;
    void Promise.resolve()
      .then(() => lateHandle.cleanup())
      .catch(() => undefined);
  };
  const startup = Promise.resolve().then(() => {
    if (abandoned) throw new Error("startup cancelled");
    return spawnerFactory(args, (currentStage) => {
      stage = currentStage;
    });
  });
  void startup.then(
    (lateHandle) => {
      if (abandoned) disposeAbandonedHandle(lateHandle);
    },
    () => undefined,
  );
  let handle: WorkflowSpawnerHandle;
  try {
    handle = await Promise.race([
      startup,
      new Promise<never>((_, reject) => {
        const timeoutMs = startupTimeoutMs;
        timer = setTimeout(() => {
          abandoned = true;
          stopReason = `timed out after ${timeoutMs}ms`;
          reject(new Error(stopReason));
        }, timeoutMs);
        onAbort = () => {
          abandoned = true;
          stopReason = "cancelled by caller";
          reject(new Error(stopReason));
        };
        if (args.signal?.aborted) onAbort();
        else args.signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (abandoned || args.signal?.aborted) {
      abandoned = true;
      disposeAbandonedHandle(handle);
      return {
        toolReturn: `Workflow startup failed during ${stage}: ${stopReason ?? "cancelled by caller"}`,
        status: "error",
      };
    }
  } catch (error) {
    abandoned = true;
    return {
      toolReturn: `Workflow startup failed during ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      status: "error",
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) args.signal?.removeEventListener("abort", onAbort);
  }

  const scriptArgs = normalizeWorkflowArgs(args.args);
  const { executionDir, scriptPath, journalPath } = createExecutionDir(
    defaultExecutionsDir(),
    newExecutionId(),
    script,
    scriptArgs,
  );

  if (args.wait) {
    try {
      const run = await executeWorkflow(handle.spawner, {
        script,
        args: scriptArgs,
        maxConcurrent: args.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        ...(args.maxCostUsd !== undefined
          ? { maxCostUsd: args.maxCostUsd }
          : {}),
        journalPath,
        ...(args.signal ? { signal: args.signal } : {}),
        ...toolOptions(handle),
      });
      return {
        toolReturn: truncateResult(formatCompletionResult(run, executionDir)),
        status: "success",
      };
    } catch (error) {
      return {
        toolReturn: `Workflow failed: ${error instanceof Error ? error.message : String(error)}`,
        status: "error",
      };
    } finally {
      await handle.cleanup().catch(() => {});
    }
  }

  const taskId = getNextWorkflowId();
  const outputFile = createBackgroundOutputFile(taskId);
  const scope = resolveNotificationScope(args.parentScope);
  const abortController =
    handle.backgroundStopController ?? new AbortController();

  const processState: BackgroundProcess = {
    process: {
      kill() {
        abortController.abort(new Error("Workflow stopped via TaskStop"));
      },
    },
    command: `workflow ${meta.name}`,
    status: "running",
    exitCode: null,
    startTime: new Date(),
    outputFile,
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

  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const publishProgress = () => {
    if (progressTimer || processState.status !== "running") return;
    progressTimer = setTimeout(() => {
      progressTimer = undefined;
      if (
        backgroundProcesses.get(taskId) === processState &&
        processState.status === "running"
      ) {
        notifyBackgroundProcessStateChanged(scope);
      }
    }, 100);
    progressTimer.unref();
  };

  const finish = (outcome: {
    run?: WorkflowExecutionResult;
    error?: string;
  }) => {
    clearTimeout(progressTimer);
    progressTimer = undefined;
    if (backgroundProcesses.get(taskId) !== processState) return;
    if (processState.status === "running") {
      processState.status = outcome.run ? "completed" : "failed";
      processState.exitCode = outcome.run ? 0 : 1;
    }
    const result = outcome.run
      ? formatCompletionResult(outcome.run, executionDir)
      : formatFailureResult(
          outcome.error,
          getWorkflowExecution(taskId)?.agentsDone ?? 0,
          journalPath,
        );
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
    const summary = outcome.run
      ? `Workflow "${meta.description}" completed · ${formatWorkflowSummary({
          durationMs,
          agentsDone: outcome.run.agentsSpawned,
          agentsTotal: outcome.run.agentsSpawned,
          totalTokens: outcome.run.totalTokens,
          totalCostUsd: outcome.run.totalCostUsd,
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
      clientMessageIds: scope?.clientMessageIds,
    });
  };

  void executeWorkflow(handle.spawner, {
    script,
    args: scriptArgs,
    maxConcurrent: args.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
    journalPath,
    signal: abortController.signal,
    ...toolOptions(handle),
    onProgress: (event) => {
      recordWorkflowProgress(taskId, event);
      if (event.kind !== "log") publishProgress();
      if (
        event.kind === "agent" &&
        event.status === "running" &&
        event.totalTokens !== undefined
      )
        return;
      const line = formatWorkflowProgressLine(event);
      if (!line) return;
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
      appendToOutputFile(outputFile, `\n[error] ${String(error)}\n`);
    })
    .finally(() => handle.cleanup().catch(() => {}));

  return {
    toolReturn: [
      `Workflow launched in background. Task ID: ${taskId}`,
      `Summary: ${meta.description}`,
      `Script file: ${scriptPath}`,
      `Journal: ${journalPath} (one line per completed agent, and per decide() API attempt including retries)`,
      `Output file: ${outputFile}`,
      "",
      "You will be notified when it completes. Do not poll or sleep — keep working or end your turn. Read the output file only when you need interim progress; TaskStop aborts the run; the user can watch live status with /workflows.",
    ].join("\n"),
    status: "success",
  };
}
