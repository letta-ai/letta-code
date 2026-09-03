/**
 * SDK-backed subagent execution.
 *
 * Every agent() call runs in its own agent-free ephemeral conversation. The
 * model and provider settings are installed atomically when that conversation
 * is created, so concurrent calls cannot mutate a shared worker agent.
 *
 * Structured output: when a call passes a schema, the session gets a custom
 * StructuredOutput SDK tool whose parameters ARE that schema. The subagent is
 * instructed to deliver its result by calling it; arguments are validated in
 * the tool's execute() and invalid calls return a model-visible error so the
 * model corrects itself. One fresh query is retried if the tool was never
 * called.
 */

import { validateAgainstSchema } from "./schema-validate.ts";
import type {
  SdkClient,
  SdkCustomTool,
  SdkQuery,
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
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
}

const DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

const SUBAGENT_PREAMBLE = `You are a subagent inside a deterministic workflow. \
You are not talking to a human: your final output is consumed by a script. \
Return raw data with no preamble, no markdown framing, and no questions.`;

const STRUCTURED_PREAMBLE = `You are a subagent inside a deterministic workflow. \
Deliver your final result by calling the StructuredOutput tool exactly once with \
arguments matching its schema. Text you write outside that tool call is discarded. \
After the tool call succeeds, stop.`;

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

async function drainTurn(
  query: SdkQuery,
  usage: RunningUsage,
): Promise<DrainedTurn> {
  let assistantText = "";
  let resultText: string | undefined;
  let success = false;
  let error: string | undefined;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  for await (const message of query) {
    if (message.type === "assistant") assistantText += message.content ?? "";
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
    const preamble = options.schema ? STRUCTURED_PREAMBLE : SUBAGENT_PREAMBLE;
    const appendParts = [
      preamble,
      this.config.systemPromptAppend,
      options.systemPrompt,
    ].filter(Boolean);

    const allowedTools = [
      ...(options.allowedTools ??
        this.config.allowedTools ??
        DEFAULT_ALLOWED_TOOLS),
      ...(options.schema ? ["StructuredOutput"] : []),
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
      ...((options.cwd ?? this.config.cwd)
        ? { cwd: options.cwd ?? this.config.cwd }
        : {}),
      ...(options.schema
        ? {
            tools: [
              buildStructuredOutputTool(options.schema, captured, () =>
                onCaptured?.(),
              ),
            ],
          }
        : {}),
    };

    // Some models keep re-calling StructuredOutput after a success (each call
    // is another cloud run), so the first valid capture ends the query: the
    // value is what the script wanted, and the rest of the turn is waste.
    let onCaptured: (() => void) | null = null;
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
    const timeout = options.timeoutMs
      ? setTimeout(
          () =>
            cancel(`Workflow subagent timed out after ${options.timeoutMs}ms`),
          options.timeoutMs,
        )
      : null;

    const runQuery = async (queryPrompt: string): Promise<DrainedTurn> => {
      const query = this.client.query({
        prompt: queryPrompt,
        options: queryOptions,
      });
      currentQuery = query;
      const usage: RunningUsage = {};
      const startedAt = Date.now();
      const capturedEarly = new Promise<DrainedTurn>((resolve) => {
        onCaptured = () => {
          void query.interrupt().catch(() => undefined);
          resolve({
            finalText: "",
            success: true,
            durationMs: Date.now() - startedAt,
            totalTokens: usage.totalTokens,
          });
        };
      });
      try {
        const drained = drainTurn(query, usage);
        // A drained stream that ends after a capture must not lose to the
        // early resolver's stale usage: prefer the full turn when it settles
        // first, otherwise the early stop.
        return await Promise.race([drained, capturedEarly, cancellation]);
      } finally {
        onCaptured = null;
        query.close();
        if (currentQuery === query) currentQuery = null;
      }
    };

    try {
      let turn = await runQuery(prompt);

      if (
        options.schema &&
        captured.length === 0 &&
        turn.success &&
        !signal.aborted
      ) {
        // Retry once in a fresh agent-free conversation. query() is one-shot,
        // so there is no persistent session to nudge.
        const nudged = await runQuery(
          `${prompt}\n\nYour previous attempt did not call StructuredOutput. Call it exactly once now with the final result matching the schema.`,
        );
        turn = {
          ...nudged,
          costUsd: sumOptional(turn.costUsd, nudged.costUsd),
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
            error: turn.error ?? "subagent never produced structured output",
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
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  /** Release SDK-owned App Server and transport resources. */
  async cleanup(): Promise<void> {
    await this.client[Symbol.asyncDispose]?.().catch(() => undefined);
  }
}
