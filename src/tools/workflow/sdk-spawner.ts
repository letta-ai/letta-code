/**
 * SDK-backed subagent execution.
 *
 * Every agent() call runs in its own agent-free ephemeral conversation. The
 * model and provider settings are installed atomically when that conversation
 * is created, so concurrent calls cannot mutate a shared worker agent.
 *
 * Structured output: local sessions get a custom StructuredOutput SDK tool;
 * remote sessions return JSON text because existing Cloud listeners may omit
 * query-scoped external tools. Both paths use the same schema validator. One
 * fresh query is retried when the tool was never called or the JSON is invalid.
 */

import {
  rejectUnsupportedPlacement,
  workflowQueryPlacement,
} from "./placement.ts";
import { validateAgainstSchema } from "./schema-validate.ts";
import type {
  SdkClient,
  SdkCustomTool,
  SdkQuery,
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
  WorkflowComputer,
} from "./types.ts";

export interface SdkSpawnerConfig {
  /** Default tool allowlist for subagents. Keep it read-only by default. */
  allowedTools?: string[];
  /** Default model resolved from the invoking conversation. */
  model?: string;
  /** Default working directory for subagent sessions. */
  cwd?: string;
  /** Extra system prompt appended to every subagent. */
  systemPromptAppend?: string;
  /** Lazy per-computer clients; reused across stages and disposed on cleanup. */
  createCloudClient?: (computer: WorkflowComputer) => SdkClient;
}

const DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Runaway guards. Live runs showed models re-issuing the identical tool call
 * dozens of times (one cloud run each) and never ending the turn; every
 * repeat re-sends the whole context. A stopped call resolves to a failed
 * outcome whose error names the guard, so the journal explains the null.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_SUBAGENT_TOOL_CALLS = 60;
export const MAX_IDENTICAL_TOOL_CALLS = 3;

const SUBAGENT_PREAMBLE = `You are a subagent inside a deterministic workflow. \
You are not talking to a human: your final output is consumed by a script. \
Return raw data with no preamble, no markdown framing, and no questions.`;

const STRUCTURED_PREAMBLE = `You are a subagent inside a deterministic workflow. \
Deliver your final result by calling the StructuredOutput tool exactly once with \
arguments matching its schema. Text you write outside that tool call is discarded. \
After the tool call succeeds, stop.`;

/** Validate the whole remote answer, never extract a plausible JSON fragment. */
export function parseStructuredText(
  text: string,
  schema: Record<string, unknown>,
): SubagentOutcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      value: null,
      failed: true,
      error: "Subagent returned invalid JSON",
    };
  }
  const issues = validateAgainstSchema(value, schema);
  return issues.length
    ? {
        value: null,
        failed: true,
        error: `Invalid structured output: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      }
    : { value, failed: false };
}

function wrapSchema(schema: Record<string, unknown>): {
  parameters: Record<string, unknown>;
  unwrap: (args: unknown) => unknown;
} {
  if (schema.type === "object") {
    return { parameters: schema, unwrap: (args) => args };
  }
  return {
    parameters: {
      type: "object",
      properties: { value: schema },
      required: ["value"],
    },
    unwrap: (args) => (args as Record<string, unknown>).value,
  };
}

function buildStructuredOutputTool(
  schema: Record<string, unknown>,
  captured: unknown[],
  onCaptured: () => void,
): SdkCustomTool {
  const { parameters, unwrap } = wrapSchema(schema);
  return {
    label: "StructuredOutput",
    name: "StructuredOutput",
    description:
      "Deliver the final structured result of your task. Call exactly once, with arguments matching the schema.",
    parameters,
    execute: async (_toolCallId, args) => {
      const value = unwrap(args);
      const issues = validateAgainstSchema(value, schema);
      if (issues.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid structured output:\n${issues
                .map((i) => `- ${i.path}: ${i.message}`)
                .join(
                  "\n",
                )}\nCall StructuredOutput again with corrected arguments.`,
            },
          ],
          isError: true,
        };
      }
      captured.push(value);
      onCaptured();
      return {
        content: [
          {
            type: "text",
            text: '{"ok":true} Result delivered. Do not call StructuredOutput again; stop now.',
          },
        ],
      };
    },
  };
}

interface DrainedTurn {
  finalText: string;
  success: boolean;
  error?: string;
  costUsd?: number;
  durationMs?: number;
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

/** Usage observed so far on a query; shared so an early stop keeps it. */
interface RunningUsage {
  totalTokens?: number;
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

async function drainTurn(
  query: SdkQuery,
  usage: RunningUsage,
  onRunaway: (reason: string) => void,
): Promise<DrainedTurn> {
  let assistantText = "";
  let resultText: string | undefined;
  let success = false;
  let error: string | undefined;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  const guard = createToolCallGuard();
  for await (const message of query) {
    if (message.type === "assistant") assistantText += message.content ?? "";
    if (message.type === "tool_call") {
      const reason = guard.onCall(
        message.toolCallId ?? "",
        message.toolName ?? "?",
        message.toolInput,
      );
      if (reason) onRunaway(reason);
    }
    if (message.type === "tool_result") {
      const reason = guard.onResult(message.toolCallId ?? "");
      if (reason) onRunaway(reason);
    }
    if (message.type === "stream_event") {
      const tokens = usageTokensFromEvent(message.event);
      if (tokens !== undefined) {
        usage.totalTokens = (usage.totalTokens ?? 0) + tokens;
      }
    }
    if (message.type === "result") {
      success = message.success === true;
      resultText = message.result;
      error = message.error ?? message.errorCode;
      costUsd = message.totalCostUsd;
      durationMs = message.durationMs;
    }
  }
  return {
    finalText: (resultText ?? assistantText).trim(),
    success,
    error,
    costUsd,
    durationMs,
    totalTokens: usage.totalTokens,
  };
}

function sumOptional(a?: number, b?: number): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export class SdkSubagentPool {
  private readonly cloudClients = new Map<string, SdkClient>();

  constructor(
    private readonly client: SdkClient,
    private readonly config: SdkSpawnerConfig = {},
  ) {}

  /** The spawner function handed to the workflow runner. */
  get spawner(): SubagentSpawner {
    return (request, signal) => this.run(request, signal);
  }

  private async run(
    request: SubagentRequest,
    signal: AbortSignal,
  ): Promise<SubagentOutcome> {
    const { prompt, options } = request;
    rejectUnsupportedPlacement(options);
    const placement = workflowQueryPlacement(
      options.computer,
      options.cwd,
      this.config.cwd,
    );
    let client = this.client;
    if (placement.backend === "cloud") {
      // SDK 0.8.x ignores per-query computer in agent-free session routing.
      // Pin a client to each selector instead; never mutate a shared default.
      const computer = placement.options.computer as WorkflowComputer;
      const key = JSON.stringify(computer);
      let remote = this.cloudClients.get(key);
      if (!remote) {
        if (!this.config.createCloudClient)
          throw new Error("Cloud workflow routing is unavailable.");
        remote = this.config.createCloudClient(computer);
        this.cloudClients.set(key, remote);
      }
      client = remote;
    }
    const model = options.model ?? this.config.model;
    if (!model) {
      return {
        value: null,
        failed: true,
        error:
          "Workflow subagent requires a model because the invoking conversation model could not be resolved.",
      };
    }
    if (signal.aborted) {
      return {
        value: null,
        failed: true,
        error: "Workflow subagent interrupted",
      };
    }
    const captured: unknown[] = [];
    // Existing Cloud listeners can execute built-in tools while omitting
    // query-scoped external tools from the model's tool list. Remote schema
    // results therefore use validated JSON text, not a callback that might
    // never be exposed. Local queries retain the StructuredOutput tool path.
    const textSchema =
      placement.backend === "cloud" ? options.schema : undefined;
    const toolSchema = textSchema ? undefined : options.schema;
    const preamble = textSchema
      ? `${SUBAGENT_PREAMBLE}\nReturn only a JSON value matching this JSON Schema, without Markdown or commentary:\n${JSON.stringify(textSchema)}`
      : toolSchema
        ? STRUCTURED_PREAMBLE
        : SUBAGENT_PREAMBLE;
    const appendParts = [
      preamble,
      this.config.systemPromptAppend,
      options.systemPrompt,
    ].filter(Boolean);

    const allowedTools = [
      ...(options.allowedTools ??
        this.config.allowedTools ??
        DEFAULT_ALLOWED_TOOLS),
      ...(toolSchema ? ["StructuredOutput"] : []),
    ];

    const queryOptions: Record<string, unknown> = {
      model,
      system: appendParts.join("\n\n"),
      permissionMode: "unrestricted",
      allowedTools,
      skillSources: [],
      ...(options.effort
        ? { modelSettings: { reasoning_effort: options.effort } }
        : {}),
      ...placement.options,
      ...(toolSchema
        ? {
            tools: [
              buildStructuredOutputTool(toolSchema, captured, () =>
                onCaptured?.(),
              ),
            ],
          }
        : {}),
    };

    // Some models keep re-calling StructuredOutput after a success (each call
    // is another cloud run), so the first valid capture ends the query: the
    // value is what the script wanted, and the rest of the turn is waste.
    // An early stop may miss the SDK result's cost. Keep it unknown; the
    // workflow must not report a partial or missing bill as zero/free.
    let onCaptured: (() => void) | null = null;
    let onRunaway: ((reason: string) => void) | null = null;
    let currentQuery: SdkQuery | null = null;
    let cancellationReject: ((error: Error) => void) | null = null;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancellationReject = reject;
    });
    const cancel = (reason: string) => {
      const query = currentQuery;
      if (query) {
        void query.interrupt().catch(() => undefined);
        query.close();
      }
      cancellationReject?.(new Error(reason));
      cancellationReject = null;
    };
    const abort = () => cancel("Workflow subagent interrupted");
    signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    const timeout = setTimeout(
      () => cancel(`Workflow subagent timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    const runQuery = async (queryPrompt: string): Promise<DrainedTurn> => {
      const query = client.query({
        prompt: queryPrompt,
        options: queryOptions,
      });
      currentQuery = query;
      const usage: RunningUsage = {};
      const startedAt = Date.now();
      const settledEarly = new Promise<DrainedTurn>((resolve) => {
        const settle = (
          turn: Omit<DrainedTurn, "durationMs" | "totalTokens">,
        ) => {
          void query.interrupt().catch(() => undefined);
          resolve({
            ...turn,
            durationMs: Date.now() - startedAt,
            totalTokens: usage.totalTokens,
          });
        };
        onCaptured = () => settle({ finalText: "", success: true });
        onRunaway = (reason) =>
          settle({ finalText: "", success: false, error: reason });
      });
      try {
        const drained = drainTurn(query, usage, (reason) =>
          onRunaway?.(reason),
        );
        // A drained stream that ends after a capture must not lose to the
        // early resolver's stale usage: prefer the full turn when it settles
        // first, otherwise the early stop.
        return await Promise.race([drained, settledEarly, cancellation]);
      } finally {
        onCaptured = null;
        onRunaway = null;
        query.close();
        if (currentQuery === query) currentQuery = null;
      }
    };

    let structuredError: string | undefined;
    const captureText = (turn: DrainedTurn) => {
      if (!textSchema || !turn.success) return;
      const parsed = parseStructuredText(turn.finalText, textSchema);
      if (parsed.failed) structuredError = parsed.error;
      else captured.push(parsed.value);
    };

    try {
      let turn = await runQuery(prompt);
      captureText(turn);

      if (
        options.schema &&
        captured.length === 0 &&
        turn.success &&
        !signal.aborted
      ) {
        // Retry once in a fresh agent-free conversation. query() is one-shot,
        // so there is no persistent session to nudge.
        const nudged = await runQuery(
          textSchema
            ? `${prompt}\n\nYour previous answer failed validation: ${structuredError}. Return only valid JSON matching the schema in your system prompt.`
            : `${prompt}\n\nYour previous attempt did not call StructuredOutput. Call it exactly once now with the final result matching the schema.`,
        );
        captureText(nudged);
        turn = {
          ...nudged,
          costUsd:
            turn.costUsd === undefined || nudged.costUsd === undefined
              ? undefined
              : turn.costUsd + nudged.costUsd,
          durationMs: sumOptional(turn.durationMs, nudged.durationMs),
          totalTokens: sumOptional(turn.totalTokens, nudged.totalTokens),
        };
      }

      const usage = {
        costUsd: turn.costUsd,
        durationMs: turn.durationMs,
        totalTokens: turn.totalTokens,
      };

      if (options.schema) {
        if (captured.length === 0) {
          return {
            value: null,
            failed: true,
            error:
              turn.error ??
              structuredError ??
              "subagent never produced structured output",
            ...usage,
          };
        }
        return {
          value: captured[captured.length - 1],
          failed: false,
          ...usage,
        };
      }

      if (!turn.success) {
        return {
          value: null,
          failed: true,
          error: turn.error ?? "subagent turn failed",
          ...usage,
        };
      }
      return { value: turn.finalText, failed: false, ...usage };
    } catch (error) {
      return { value: null, failed: true, error: String(error) };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  /** Release SDK-owned App Server and transport resources. */
  async cleanup(): Promise<void> {
    await Promise.all(
      [this.client, ...this.cloudClients.values()].map((client) =>
        client?.[Symbol.asyncDispose]?.().catch(() => undefined),
      ),
    );
  }
}
