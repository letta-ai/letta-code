/**
 * SDK-backed subagent execution: one agent() call is one Agent SDK query()
 * in its own agent-free ephemeral conversation, linked to the invoking parent
 * agent. The model is installed when that conversation is created, so
 * concurrent calls with different models never touch a shared agent.
 */

import { getClient } from "@/backend/api/client";
import { apiRequest } from "@/backend/api/request";
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
  /** Invoking agent supplies permissions/resources, never child history ownership. */
  parentAgentId: string;
  /** Default model handle for subagents. */
  model: string;
  /** Resolves a handle or alias from agent() opts; null when unknown. */
  resolveModel?: (identifier: string) => string | null;
  /** Default tool allowlist for subagents. Keep it read-only by default. */
  allowedTools?: string[];
  /** Working directory for subagent sessions. */
  cwd?: string;
  /** Resume is gated on a verified SDK release; 0.8.17 silently creates a new child. */
  supportsAgentFreeResume?: boolean;
  /** Persisted conversation lookup (injected for focused tests). */
  retrieveConversation?: (id: string) => Promise<WorkerConversation>;
  /** Latest persisted conversation run (injected for focused tests). */
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
  const client = await getClient();
  const messages = await client.conversations.messages.list(conversationId, {
    limit: 100,
    order: "desc",
  });
  const runId = messages
    .getPaginatedItems()
    .map((message) => message.run_id)
    .find(
      (id): id is string => typeof id === "string" && id.startsWith("run-"),
    );
  if (!runId) return null;
  return client.runs.retrieve(runId);
}

async function retrieveWorkerConversation(
  id: string,
): Promise<WorkerConversation> {
  return apiRequest<WorkerConversation>(
    "GET",
    `/v1/conversations/${encodeURIComponent(id)}`,
  );
}

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Runaway guards. Live runs showed models re-issuing the identical tool call
 * dozens of times and never ending the turn; every repeat re-sends the whole
 * context. A stopped call resolves to a failed outcome whose error names the
 * guard, so the journal explains the null.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_SUBAGENT_TOOL_CALLS = 1000;
export const MAX_IDENTICAL_TOOL_CALLS = 3;

const SUBAGENT_PREAMBLE = `You are a subagent inside a deterministic workflow. \
You are not talking to a human: your final output is consumed by a script. \
Return raw data with no preamble, no markdown framing, and no questions.`;

const JSON_PREAMBLE = `Your final message must be a single JSON value and \
nothing else: no prose, no markdown code fence.`;

/** Parse a JSON reply, tolerating a ``` fence the model added anyway. */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

/**
 * Watches tool calls for the runaway patterns above; returns a stop reason.
 *
 * The SDK streams one `tool_call` message per argument delta, so a call is
 * counted once per toolCallId. Each message carries only a *partial* `toolInput`
 * (often `{}` or `{ raw: "<fragment>" }`), so the guard accumulates the raw
 * argument fragments and judges the identical-call check on the assembled
 * arguments when the call's result arrives. Reading the per-delta `toolInput`
 * directly would treat an incomplete fragment as the call's identity and
 * false-flag distinct calls.
 */

/** What the guard tracks for one streamed tool call. */
interface TrackedToolCall {
  name: string;
  /** Most recent decoded `toolInput`; a last-resort identity fallback. */
  lastInput: unknown;
  /** Running concatenation of raw argument fragments, when any were seen. */
  raw?: string;
  /** Complete decoded arguments when no raw delta stream was available. */
  complete?: unknown;
}

function asArgumentObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The argument fragment carried by a streamed `tool_call` message. Prefers the
 * explicit `rawArguments`; SDKs that omit it wrap the fragment as
 * `{ raw: "<fragment>" }` via their own argument decoder, which is unwrapped
 * here. A fragment only counts when it carries content.
 */
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

/**
 * Fold one streamed argument delta into the call's accumulated state. A delta
 * can itself be valid JSON (for example an interior `{}`), so raw fragments
 * are always concatenated and are never treated as standalone snapshots.
 */
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
  // No raw fragment on the wire: a fully decoded, non-empty object input is
  // authoritative (older SDKs and direct callers supply whole arguments).
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
      // A call can surface more than one result message (local execution
      // plus the server's tool return); judge each call once.
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
}

/** Token usage observed so far on a query; shared so an early stop keeps it. */
interface RunningUsage {
  totalTokens?: number;
}

/**
 * The SDK forwards Letta `usage_statistics` stream payloads verbatim as
 * `stream_event` messages (its result message carries cost but not tokens).
 * One usage record is emitted per agent step; summing `total_tokens` across
 * them is the session's token usage.
 */
function usageTokensFromEvent(
  event: Record<string, unknown> | undefined,
): number | undefined {
  if (!event || event.message_type !== "usage_statistics") return undefined;
  const total = event.total_tokens;
  return typeof total === "number" && Number.isFinite(total)
    ? total
    : undefined;
}

/** Consume the query stream to its result; `stop` is called on a runaway. */
async function drainTurn(
  query: SdkQuery,
  usage: RunningUsage,
  stop: (reason: string) => void,
  maxToolCalls: number,
  onUsage?: (totalTokens: number) => void,
  onStarted?: (conversationId: string) => void,
): Promise<DrainedTurn> {
  let assistantText = "";
  let resultText: string | undefined;
  let success = false;
  let error: string | undefined;
  let structuredOutput: unknown;
  let startedNotified = false;
  const guard = createToolCallGuard(maxToolCalls);
  for await (const message of query) {
    // The SDK sends loop_status before inference, not an init message.
    // Capture the conversation as soon as any stream event exposes it.
    const id = query.conversationId ?? message.conversationId;
    if (!startedNotified && id) {
      startedNotified = true;
      onStarted?.(id);
    }
    if (message.type === "assistant") assistantText += message.content ?? "";
    if (message.type === "stream_event") {
      const tokens = usageTokensFromEvent(message.event);
      if (tokens !== undefined) {
        usage.totalTokens = (usage.totalTokens ?? 0) + tokens;
        onUsage?.(usage.totalTokens);
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
  return {
    model,
    ...(options.schema
      ? { outputFormat: { type: "json_schema", schema: options.schema } }
      : {}),
    parentAgentId: config.parentAgentId,
    isSubagent: true,
    name: options.label ?? `Workflow worker ${callIndex + 1}`,
    system,
    permissionMode: "unrestricted",
    allowedTools:
      options.allowedTools ??
      (options.conversationId
        ? []
        : (config.allowedTools ?? DEFAULT_ALLOWED_TOOLS)),
    skillSources: [],
    ...(config.cwd ? { cwd: config.cwd } : {}),
    disableMemoryGuard: true,
    ...(options.effort
      ? { modelSettings: { reasoning_effort: options.effort } }
      : {}),
  };
}

export function createSdkSpawner(
  client: SdkClient,
  config: SdkSpawnerConfig,
): SubagentSpawner {
  return async (
    request: SubagentRequest,
    signal: AbortSignal,
    hooks?: SubagentSpawnHooks,
  ): Promise<SubagentOutcome> => {
    const { prompt, options } = request;
    const resumeId = options.conversationId;
    if (resumeId !== undefined && !/^conv-[A-Za-z0-9_-]+$/.test(resumeId)) {
      throw new Error("agent() conversationId must be a conv-... ID.");
    }
    // Never hand conversationId to an older SDK: it ignores the option and
    // creates a fresh worker, silently losing the conversation history.
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
    if (persisted && resumeId) {
      // SDK App Server turns have Runs, not Super Runs. If the latest
      // persisted message has no run ID or the run is not terminal, do not
      // risk sending a second prompt into an active conversation.
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
    // System prompt is a creation-time setting; do not imply it changes on
    // resume. Tool and output choices are explicit per turn, not inherited.
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
    if (signal.aborted) {
      return {
        value: null,
        failed: true,
        error: "Workflow subagent interrupted",
      };
    }

    const startedAt = Date.now();
    const usage: RunningUsage = {};
    const query = client.query({
      prompt,
      options: {
        ...buildQueryOptions(options, model, config, request.callIndex),
        ...(resumeId ? { conversationId: resumeId } : {}),
      },
    });
    if (resumeId && query.conversationId && query.conversationId !== resumeId) {
      query.close();
      throw new Error(
        "SDK resumed an unexpected worker conversation; refusing continuation.",
      );
    }
    // Stopping early (abort, timeout, runaway) interrupts the turn and
    // settles the outcome; the stream drain then ends on its own.
    let settleStopped!: (turn: DrainedTurn) => void;
    const stopped = new Promise<DrainedTurn>((resolve) => {
      settleStopped = resolve;
    });
    let finished = false;
    const stop = (reason: string) => {
      if (finished) return;
      finished = true;
      void query.interrupt().catch(() => undefined);
      query.close();
      settleStopped({
        finalText: "",
        success: false,
        error: reason,
        totalTokens: usage.totalTokens,
      });
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
          stop,
          options.maxToolCalls ?? DEFAULT_MAX_SUBAGENT_TOOL_CALLS,
          (totalTokens) => {
            if (!finished) hooks?.onUsage?.(totalTokens);
          },
          (id) => {
            if (resumeId && id !== resumeId) {
              stop("SDK resumed an unexpected worker conversation");
            } else if (!finished) {
              hooks?.onStarted?.(id);
            }
          },
        ),
        stopped,
      ]);
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
      signal.removeEventListener("abort", abort);
      query.close();
    }
  };
}
