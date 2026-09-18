/**
 * SDK-backed subagent execution: one agent() call is one Agent SDK query()
 * in its own agent-free ephemeral conversation, linked to the invoking parent
 * agent. The model is installed when that conversation is created, so
 * concurrent calls with different models never touch a shared agent.
 */

import type {
  AgentCallOptions,
  SdkClient,
  SdkQuery,
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
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
}

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Runaway guards. Live runs showed models re-issuing the identical tool call
 * dozens of times and never ending the turn; every repeat re-sends the whole
 * context. A stopped call resolves to a failed outcome whose error names the
 * guard, so the journal explains the null.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_SUBAGENT_TOOL_CALLS = 60;
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
 * counted once per toolCallId, and the identical-call check runs when the
 * call's result arrives (its input is complete by then).
 */
function createToolCallGuard(): {
  onCall(id: string, name: string, input: unknown): string | null;
  onResult(id: string): string | null;
} {
  const calls = new Map<string, { name: string; input: unknown }>();
  const judged = new Set<string>();
  let lastKey = "";
  let repeats = 0;
  return {
    onCall(id, name, input) {
      const first = !calls.has(id);
      calls.set(id, { name, input });
      if (first && calls.size > MAX_SUBAGENT_TOOL_CALLS) {
        return `subagent exceeded ${MAX_SUBAGENT_TOOL_CALLS} tool calls`;
      }
      return null;
    },
    onResult(id) {
      const call = calls.get(id);
      // A call can surface more than one result message (local execution
      // plus the server's tool return); judge each call once.
      if (!call || judged.has(id)) return null;
      judged.add(id);
      let key: string;
      try {
        key = `${call.name}:${JSON.stringify(call.input)}`;
      } catch {
        key = `${call.name}:${String(call.input)}`;
      }
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
}

/** Consume the query stream to its result; `stop` is called on a runaway. */
async function drainTurn(
  query: SdkQuery,
  stop: (reason: string) => void,
): Promise<DrainedTurn> {
  let assistantText = "";
  let resultText: string | undefined;
  let success = false;
  let error: string | undefined;
  const guard = createToolCallGuard();
  for await (const message of query) {
    if (message.type === "assistant") assistantText += message.content ?? "";
    if (message.type === "tool_call") {
      const reason = guard.onCall(
        message.toolCallId ?? "",
        message.toolName ?? "?",
        message.toolInput,
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
      error = message.error ?? message.errorCode;
    }
  }
  return { finalText: (resultText ?? assistantText).trim(), success, error };
}

function buildQueryOptions(
  options: AgentCallOptions,
  model: string,
  config: SdkSpawnerConfig,
  callIndex: number,
): Record<string, unknown> {
  const system = [
    SUBAGENT_PREAMBLE,
    options.json ? JSON_PREAMBLE : undefined,
    options.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    model,
    parentAgentId: config.parentAgentId,
    isSubagent: true,
    name: options.label ?? `Workflow worker ${callIndex + 1}`,
    system,
    permissionMode: "unrestricted",
    allowedTools:
      options.allowedTools ?? config.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    skillSources: [],
    ...(config.cwd ? { cwd: config.cwd } : {}),
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
  ): Promise<SubagentOutcome> => {
    const { prompt, options } = request;
    const model = options.model
      ? (config.resolveModel?.(options.model) ?? null)
      : config.model;
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
    const query = client.query({
      prompt,
      options: buildQueryOptions(options, model, config, request.callIndex),
    });
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
      settleStopped({ finalText: "", success: false, error: reason });
    };
    const abort = () => stop("Workflow subagent interrupted");
    signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    const timeout = setTimeout(
      () => stop(`Workflow subagent timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    try {
      const turn = await Promise.race([drainTurn(query, stop), stopped]);
      const usage = {
        durationMs: Date.now() - startedAt,
        ...(query.conversationId
          ? { conversationId: query.conversationId }
          : {}),
      };
      if (!turn.success) {
        return {
          value: null,
          failed: true,
          error: turn.error ?? "subagent turn failed",
          ...usage,
        };
      }
      if (options.json) {
        try {
          return {
            value: parseJsonReply(turn.finalText),
            failed: false,
            ...usage,
          };
        } catch {
          return {
            value: null,
            failed: true,
            error: `Subagent reply was not valid JSON: ${turn.finalText.slice(0, 200)}`,
            ...usage,
          };
        }
      }
      return { value: turn.finalText, failed: false, ...usage };
    } catch (error) {
      return { value: null, failed: true, error: String(error) };
    } finally {
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      query.close();
    }
  };
}
