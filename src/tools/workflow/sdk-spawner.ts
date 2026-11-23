import { loadPreloadedSkills } from "@/agent/preloaded-skills";
import { getBackend } from "@/backend";
import { getAvailableModToolsRegistry } from "@/mods/tool-registry";
import type { RuntimePermissionMode } from "@/runtime-context";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";
import { getInternalToolName } from "@/tools/tool-name-mapping";
import { priceUsageEvent } from "@/usage/cost";
import type {
  AgentCallOptions,
  SdkClient,
  SdkQuery,
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
  SubagentSpawnHooks,
} from "./types.ts";

export interface SdkSpawnerConfig {
  parentAgentId: string;
  model: string;
  resolveModel?: (identifier: string) => string | null;
  allowedTools?: string[];
  parentToolNames?: string[];
  agentScopedToolNames?: string[];
  permissionMode?: RuntimePermissionMode;
  cwd?: string;
  parentModelSettings?: Record<string, unknown>;
  parentContextWindowLimit?: number | null;
  supportsAgentFreeResume?: boolean;
  verifyPersistedRuns?: boolean;
  stopDrainMs?: number;
  retrieveConversation?: (id: string) => Promise<WorkerConversation>;
  latestRun?: (id: string) => Promise<WorkerRun | null>;
}

export interface WorkerConversation {
  agent_id: string | null;
  parent_agent_id?: string | null;
  model?: string | null;
}

export interface WorkerRun {
  id: string;
  conversation_id?: string | null;
  status?: string;
  completed_at?: string | null;
}

async function latestWorkerRun(
  conversationId: string,
): Promise<WorkerRun | null> {
  return getBackend().latestConversationRun(conversationId);
}

async function retrieveWorkerConversation(
  id: string,
): Promise<WorkerConversation> {
  return getBackend().retrieveConversation(id) as Promise<WorkerConversation>;
}

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_SUBAGENT_TOOL_CALLS = 1000;
export const STOP_DRAIN_MS = 5_000;
export const MAX_IDENTICAL_TOOL_CALLS = 3;

const SUBAGENT_PREAMBLE = `You are a subagent inside a deterministic workflow. \
You are not talking to a human: your final output is consumed by a script. \
Return raw data with no preamble, no markdown framing, and no questions.`;

const JSON_PREAMBLE = `Your final message must be a single JSON value and \
nothing else: no prose, no markdown code fence.`;

export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

interface TrackedToolCall {
  name: string;
  lastInput: unknown;
  raw?: string;
  complete?: unknown;
}

function asArgumentObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function argumentFragment(
  input: unknown,
  rawArguments: string | undefined,
): string | undefined {
  if (typeof rawArguments === "string" && rawArguments.length > 0) {
    return rawArguments;
  }
  const wrapped = asArgumentObject(input);
  if (wrapped && Object.keys(wrapped).length === 1) {
    const raw = wrapped.raw;
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

function stringifyArguments(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function recordArgumentFragment(
  call: TrackedToolCall,
  input: unknown,
  rawArguments: string | undefined,
): void {
  const fragment = argumentFragment(input, rawArguments);
  if (fragment !== undefined) {
    call.raw = call.raw === undefined ? fragment : call.raw + fragment;
    call.complete = undefined;
    return;
  }
  if (call.complete === undefined && call.raw === undefined) {
    const decoded = asArgumentObject(input);
    if (decoded && Object.keys(decoded).length > 0) {
      call.complete = decoded;
    }
  }
}

function createToolCallGuard(maxToolCalls: number): {
  onCall(
    id: string,
    name: string,
    input: unknown,
    rawArguments?: string,
  ): string | null;
  onResult(id: string): string | null;
} {
  const calls = new Map<string, TrackedToolCall>();
  const judged = new Set<string>();
  let lastKey = "";
  let repeats = 0;
  return {
    onCall(id, name, input, rawArguments) {
      let call = calls.get(id);
      const first = call === undefined;
      if (!call) {
        call = { name: name || "?", lastInput: input };
        calls.set(id, call);
      }
      if (name && name !== "?") call.name = name;
      call.lastInput = input;
      recordArgumentFragment(call, input, rawArguments);
      if (first && calls.size > maxToolCalls) {
        return `subagent exceeded ${maxToolCalls} tool calls`;
      }
      return null;
    },
    onResult(id) {
      const call = calls.get(id);
      if (!call || judged.has(id)) return null;
      judged.add(id);
      const identity =
        call.complete !== undefined
          ? stringifyArguments(call.complete)
          : (call.raw ?? stringifyArguments(call.lastInput));
      const key = `${call.name}:${identity}`;
      repeats = key === lastKey ? repeats + 1 : 1;
      lastKey = key;
      if (repeats >= MAX_IDENTICAL_TOOL_CALLS) {
        return `subagent repeated the identical ${call.name} call ${repeats} times`;
      }
      return null;
    },
  };
}

interface DrainedTurn {
  finalText: string;
  success: boolean;
  error?: string;
  structuredOutput?: unknown;
  totalTokens?: number;
  costUsd?: number | null;
}

interface RunningUsage {
  totalTokens?: number;
  costUsd?: number;
  unpriced?: boolean;
}

const PROVIDER_STEP_STATUSES = new Set([
  "SENDING_API_REQUEST",
  "WAITING_FOR_API_RESPONSE",
  "PROCESSING_API_RESPONSE",
]);

interface StepState {
  inFlight: boolean;
  onStepEnd?: () => void;
}

function runningCost(usage: RunningUsage): number | null | undefined {
  return usage.unpriced ? null : usage.costUsd;
}

function usageTokensFromEvent(
  event: Record<string, unknown> | undefined,
): number | undefined {
  if (!event || event.message_type !== "usage_statistics") return undefined;
  const total = event.total_tokens;
  return typeof total === "number" && Number.isFinite(total)
    ? total
    : undefined;
}

function recordUsageCost(
  event: Record<string, unknown> | undefined,
  usage: RunningUsage,
): boolean {
  if (!event || event.message_type !== "usage_statistics") return false;
  const cost = event.api_cost_usd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    usage.costUsd = (usage.costUsd ?? 0) + cost;
  } else {
    usage.unpriced = true;
  }
  return true;
}

async function drainTurn(
  query: SdkQuery,
  usage: RunningUsage,
  step: StepState,
  stop: (reason: string) => void,
  maxToolCalls: number,
  onUsage?: (totalTokens: number, costUsd?: number | null) => void,
  onStarted?: (conversationId: string) => void,
  model?: string,
): Promise<DrainedTurn> {
  let assistantText = "";
  let resultText: string | undefined;
  let success = false;
  let error: string | undefined;
  let structuredOutput: unknown;
  let startedNotified = false;
  const guard = createToolCallGuard(maxToolCalls);
  for await (const message of query) {
    const id = query.conversationId ?? message.conversationId;
    if (!startedNotified && id) {
      startedNotified = true;
      onStarted?.(id);
    }
    if (message.type === "loop_status" && typeof message.status === "string") {
      step.inFlight = PROVIDER_STEP_STATUSES.has(message.status);
      if (!step.inFlight) step.onStepEnd?.();
    }
    if (message.type === "assistant") assistantText += message.content ?? "";
    if (message.type === "stream_event") {
      if (message.event) message.event = priceUsageEvent(message.event, model);
      const tokens = usageTokensFromEvent(message.event);
      if (tokens !== undefined) {
        usage.totalTokens = (usage.totalTokens ?? 0) + tokens;
      }
      if (recordUsageCost(message.event, usage)) {
        onUsage?.(usage.totalTokens ?? 0, runningCost(usage));
        step.inFlight = false;
        step.onStepEnd?.();
      }
    }
    if (message.type === "tool_call") {
      const reason = guard.onCall(
        message.toolCallId ?? "",
        message.toolName ?? "?",
        message.toolInput,
        message.rawArguments,
      );
      if (reason) stop(reason);
    }
    if (message.type === "tool_result") {
      const reason = guard.onResult(message.toolCallId ?? "");
      if (reason) stop(reason);
    }
    if (message.type === "result") {
      success = message.success === true;
      resultText = message.result;
      error = message.errorDetail ?? message.error ?? message.errorCode;
      structuredOutput = message.structuredOutput;
    }
  }
  return {
    finalText: (resultText ?? assistantText).trim(),
    success,
    error,
    structuredOutput,
    totalTokens: usage.totalTokens,
    costUsd: runningCost(usage),
  };
}

function buildQueryOptions(
  options: AgentCallOptions,
  model: string,
  config: SdkSpawnerConfig,
  callIndex: number,
): Record<string, unknown> {
  const system = [
    SUBAGENT_PREAMBLE,
    options.json && !options.schema ? JSON_PREAMBLE : undefined,
    options.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  const modelSettings = {
    ...(!options.model ? config.parentModelSettings : {}),
    ...(options.effort ? { reasoning_effort: options.effort } : {}),
  };
  const explicitAllowedTools = options.allowedTools ?? config.allowedTools;
  const bundledTools = new Set<string>(Object.keys(TOOL_DEFINITIONS));
  const globalModTools = new Set(
    Array.from(getAvailableModToolsRegistry().entries()).flatMap(
      ([name, tool]) =>
        tool.owner?.scope === "agent"
          ? []
          : [getInternalToolName(name), getInternalToolName(tool.name)],
    ),
  );
  const agentScopedTools = new Set(
    (config.agentScopedToolNames ?? []).map(getInternalToolName),
  );
  const isWorkerResolvable = (name: string): boolean => {
    const internalName = getInternalToolName(name);
    return bundledTools.has(internalName) || globalModTools.has(internalName);
  };
  const unknownTool = explicitAllowedTools?.find(
    (name) => !isWorkerResolvable(name),
  );
  if (unknownTool !== undefined) {
    if (agentScopedTools.has(getInternalToolName(unknownTool))) {
      throw new Error(
        `Workflow worker tool "${unknownTool}" is agent-scoped and is not available to workflow workers.`,
      );
    }
    throw new Error(
      `Unknown workflow worker tool "${unknownTool}": it is neither a bundled tool nor a global mod tool available to workflow workers.`,
    );
  }
  const allowedTools =
    explicitAllowedTools ?? config.parentToolNames?.filter(isWorkerResolvable);
  return {
    model,
    ...(options.schema
      ? { outputFormat: { type: "json_schema", schema: options.schema } }
      : {}),
    parentAgentId: config.parentAgentId,
    isSubagent: true,
    name: options.label ?? `Workflow worker ${callIndex + 1}`,
    system,
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(allowedTools !== undefined
      ? {
          allowedTools: [...allowedTools],
          toolset: {
            base: "none",
            include: allowedTools
              .map(getInternalToolName)
              .filter((name) => bundledTools.has(name)),
          },
        }
      : {}),
    skillSources: [],
    ...(config.cwd ? { cwd: config.cwd } : {}),
    disableMemoryGuard: true,
    ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
    ...(!options.model && config.parentContextWindowLimit !== undefined
      ? { contextWindowLimit: config.parentContextWindowLimit }
      : {}),
  };
}

export function createSdkSpawner(
  client: SdkClient,
  config: SdkSpawnerConfig,
): SubagentSpawner {
  const activeResumeIds = new Set<string>();
  const locallyCompletedIds = new Set<string>();
  return async (
    request: SubagentRequest,
    signal: AbortSignal,
    hooks?: SubagentSpawnHooks,
  ): Promise<SubagentOutcome> => {
    const { prompt, options } = request;
    const resumeId = options.conversationId;
    if (
      resumeId !== undefined &&
      !/^(?:conv-|local-conv-)[A-Za-z0-9_-]+$/.test(resumeId)
    ) {
      throw new Error(
        "agent() conversationId must be a conv-... or local-conv-... ID.",
      );
    }
    if (resumeId && !config.supportsAgentFreeResume) {
      throw new Error(
        "Workflow worker continuation requires an Agent SDK release with agent-free query() resume support.",
      );
    }
    const persisted = resumeId
      ? await (config.retrieveConversation ?? retrieveWorkerConversation)(
          resumeId,
        )
      : null;
    if (
      persisted &&
      (persisted.agent_id !== null ||
        persisted.parent_agent_id !== config.parentAgentId)
    ) {
      throw new Error(
        "Worker conversation is not agent-free or belongs to another parent agent.",
      );
    }
    if (
      persisted &&
      resumeId &&
      config.verifyPersistedRuns === false &&
      !locallyCompletedIds.has(resumeId) &&
      !activeResumeIds.has(resumeId)
    ) {
      throw new Error(
        "Local worker continuation is only safe within the workflow execution that completed it.",
      );
    }
    if (persisted && resumeId && config.verifyPersistedRuns !== false) {
      const latest = await (config.latestRun ?? latestWorkerRun)(resumeId);
      if (
        !latest ||
        latest.conversation_id !== resumeId ||
        !["completed", "failed", "cancelled"].includes(latest.status ?? "")
      ) {
        throw new Error(
          "Cannot confirm worker's latest run is terminal; reconcile it before continuing.",
        );
      }
    }
    if (
      persisted &&
      (!persisted.model || typeof persisted.model !== "string")
    ) {
      throw new Error(
        "Worker conversation has no persisted model; cannot continue safely.",
      );
    }
    const selectedModel = options.model
      ? (config.resolveModel?.(options.model) ?? null)
      : config.model;
    if (persisted && options.systemPrompt !== undefined) {
      throw new Error(
        "agent() continuation cannot override the worker system prompt.",
      );
    }
    if (persisted && options.model && selectedModel !== persisted.model) {
      throw new Error(
        "agent() continuation model must match the persisted worker model.",
      );
    }
    const model = persisted ? persisted.model : selectedModel;
    if (!model) {
      return {
        value: null,
        failed: true,
        error: `Unknown model "${options.model}". Run \`letta model list\` for valid handles.`,
      };
    }
    const loadedSkills = options.skills?.length
      ? await loadPreloadedSkills(options.skills, {
          agentId: config.parentAgentId,
          ...(config.cwd ? { workingDirectory: config.cwd } : {}),
        })
      : "";
    const missingSkills = (options.skills ?? []).filter(
      (id) => !loadedSkills.includes(`<${id}>\n`),
    );
    if (missingSkills.length) {
      return {
        value: null,
        failed: true,
        error: `Unknown skill(s): ${missingSkills.join(", ")}.`,
      };
    }
    if (signal.aborted) {
      return {
        value: null,
        failed: true,
        error: "Workflow subagent interrupted",
      };
    }

    if (resumeId && activeResumeIds.has(resumeId)) {
      throw new Error(
        "Worker conversation already has an active workflow turn.",
      );
    }
    if (resumeId) activeResumeIds.add(resumeId);
    let activeId = resumeId;
    const startedAt = Date.now();
    const usage: RunningUsage = {};
    let query: SdkQuery;
    try {
      query = client.query({
        prompt: loadedSkills ? `${loadedSkills}\n\n${prompt}` : prompt,
        options: {
          ...buildQueryOptions(options, model, config, request.callIndex),
          ...(resumeId ? { conversationId: resumeId } : {}),
        },
      });
    } catch (error) {
      if (activeId) activeResumeIds.delete(activeId);
      throw error;
    }
    if (resumeId && query.conversationId && query.conversationId !== resumeId) {
      query.close();
      activeResumeIds.delete(resumeId);
      throw new Error(
        "SDK resumed an unexpected worker conversation; refusing continuation.",
      );
    }
    let settleStopped!: (turn: DrainedTurn) => void;
    const stopped = new Promise<DrainedTurn>((resolve) => {
      settleStopped = resolve;
    });
    let finished = false;
    let stopReason: string | undefined;
    let interrupted = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const step: StepState = { inFlight: false };
    const interrupt = () => {
      step.onStepEnd = undefined;
      if (interrupted) return;
      interrupted = true;
      void query.interrupt().catch(() => undefined);
    };
    const stop = (reason: string) => {
      if (finished || stopReason !== undefined) return;
      stopReason = reason;
      if (step.inFlight) step.onStepEnd = interrupt;
      else interrupt();
      drainTimer = setTimeout(() => {
        interrupt();
        finished = true;
        query.close();
        settleStopped({
          finalText: "",
          success: false,
          error: reason,
          totalTokens: usage.totalTokens,
          costUsd: runningCost(usage),
        });
      }, config.stopDrainMs ?? STOP_DRAIN_MS);
    };
    const abort = () => stop("Workflow subagent interrupted");
    signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    const timeout = setTimeout(
      () => stop(`Workflow subagent timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    try {
      const turn = await Promise.race([
        drainTurn(
          query,
          usage,
          step,
          stop,
          options.maxToolCalls ?? DEFAULT_MAX_SUBAGENT_TOOL_CALLS,
          (totalTokens, costUsd) => {
            if (!finished) hooks?.onUsage?.(totalTokens, costUsd);
          },
          (id) => {
            if (resumeId && id !== resumeId) {
              stop("SDK resumed an unexpected worker conversation");
            } else if (!finished) {
              if (!activeId) {
                activeId = id;
                activeResumeIds.add(id);
              }
              hooks?.onStarted?.(id);
            }
          },
          model,
        ),
        stopped,
      ]).then((drained): DrainedTurn => {
        if (stopReason === undefined) return drained;
        return {
          finalText: "",
          success: false,
          error: stopReason,
          totalTokens: usage.totalTokens,
          costUsd: runningCost(usage),
        };
      });
      if (!finished && stopReason === undefined && query.conversationId) {
        locallyCompletedIds.add(query.conversationId);
      }
      if (resumeId && query.conversationId !== resumeId) {
        throw new Error(
          "SDK did not resume the requested worker conversation.",
        );
      }
      const stats = {
        durationMs: Date.now() - startedAt,
        ...(turn.totalTokens !== undefined
          ? { totalTokens: turn.totalTokens }
          : {}),
        ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
        ...(query.conversationId
          ? { conversationId: query.conversationId }
          : {}),
      };
      if (!turn.success) {
        const outcome = {
          value: null,
          failed: true,
          error: turn.error ?? "subagent turn failed",
          ...stats,
        };
        return outcome;
      }
      if (options.schema) {
        const outcome = {
          value: turn.structuredOutput,
          failed: false,
          ...stats,
        };
        return outcome;
      }
      if (options.json) {
        try {
          const outcome = {
            value: parseJsonReply(turn.finalText),
            failed: false,
            ...stats,
          };
          return outcome;
        } catch {
          const outcome = {
            value: null,
            failed: true,
            error: `Subagent reply was not valid JSON: ${turn.finalText.slice(0, 200)}`,
            ...stats,
          };
          return outcome;
        }
      }
      const outcome = { value: turn.finalText, failed: false, ...stats };
      return outcome;
    } catch (error) {
      const outcome = {
        value: null,
        failed: true,
        error: String(error),
        ...(query.conversationId || resumeId
          ? { conversationId: query.conversationId ?? resumeId }
          : {}),
      };
      return outcome;
    } finally {
      finished = true;
      clearTimeout(timeout);
      clearTimeout(drainTimer);
      signal.removeEventListener("abort", abort);
      query.close();
      if (activeId) activeResumeIds.delete(activeId);
    }
  };
}
