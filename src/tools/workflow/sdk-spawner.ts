/**
 * SDK-backed subagent execution.
 *
 * All subagents in a run share one ephemeral worker agent; each agent() call
 * opens a fresh stateless session (its own conversation, no MemFS load), so
 * subagents are context-isolated without polluting anyone's long-term memory.
 * The worker agent is deleted when the run finishes.
 *
 * Structured output: when a call passes a schema, the session gets a custom
 * StructuredOutput SDK tool whose parameters ARE that schema. The subagent is
 * instructed to deliver its result by calling it; arguments are validated in
 * the tool's execute() and invalid calls return a model-visible error so the
 * model corrects itself. One nudge turn is sent if the tool was never called.
 */

import { validateAgainstSchema } from "./schema-validate.ts";
import type {
  SdkClient,
  SdkCustomTool,
  SdkSession,
  SubagentOutcome,
  SubagentRequest,
  SubagentSpawner,
} from "./types.ts";

export interface SdkSpawnerConfig {
  /** Default tool allowlist for subagents. Keep it read-only by default. */
  allowedTools?: string[];
  /** Default model for subagents (omit to inherit the agent default). */
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
      return { content: [{ type: "text", text: '{"ok":true}' }] };
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

async function drainTurn(session: SdkSession): Promise<DrainedTurn> {
  let assistantText = "";
  let resultText: string | undefined;
  let success = false;
  let error: string | undefined;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  let totalTokens: number | undefined;
  for await (const message of session.stream()) {
    if (message.type === "assistant") assistantText += message.content ?? "";
    if (message.type === "stream_event") {
      const tokens = usageTokensFromEvent(message.event);
      if (tokens !== undefined) totalTokens = (totalTokens ?? 0) + tokens;
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
    totalTokens,
  };
}

function sumOptional(a?: number, b?: number): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export class SdkSubagentPool {
  private workerAgentId: string | null = null;
  private workerAgentPromise: Promise<string> | null = null;

  constructor(
    private readonly client: SdkClient,
    private readonly config: SdkSpawnerConfig = {},
  ) {}

  /** The spawner function handed to the workflow runner. */
  get spawner(): SubagentSpawner {
    return (request, signal) => this.run(request, signal);
  }

  private ensureWorkerAgent(): Promise<string> {
    if (!this.workerAgentPromise) {
      this.workerAgentPromise = this.client
        .createAgent({
          name: "workflow-worker",
          description:
            "Ephemeral worker agent for Workflow-tool subagent sessions.",
          tags: ["letta-workflow:worker"],
        })
        .then((agentId) => {
          this.workerAgentId = agentId;
          return agentId;
        });
    }
    return this.workerAgentPromise;
  }

  private async run(
    request: SubagentRequest,
    signal: AbortSignal,
  ): Promise<SubagentOutcome> {
    const { prompt, options } = request;
    const agentId = await this.ensureWorkerAgent();
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

    // Every createSession() opens a fresh conversation on the worker, so each
    // call is context-isolated either way. Stateless additionally skips the
    // worker's MemFS/transcript, but the SDK refuses model/reasoningEffort on
    // stateless sessions (they would persist); calls that set them run on a
    // regular session where the override scopes to that new conversation.
    const model = options.model ?? this.config.model;
    const stateless = model === undefined && options.effort === undefined;
    let session: SdkSession;
    try {
      session = this.client.createSession(agentId, {
        stateless,
        permissionMode: "unrestricted",
        allowedTools,
        ...(model ? { model } : {}),
        ...(options.effort ? { reasoningEffort: options.effort } : {}),
        ...((options.cwd ?? this.config.cwd)
          ? { cwd: options.cwd ?? this.config.cwd }
          : {}),
        ...(options.schema
          ? { tools: [buildStructuredOutputTool(options.schema, captured)] }
          : {}),
      });
    } catch (error) {
      // Option validation errors are per-call failures, not workflow crashes.
      return { value: null, failed: true, error: String(error) };
    }

    const abort = () => void session.abort().catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs
      ? setTimeout(abort, options.timeoutMs)
      : null;

    try {
      const fullPrompt = `${appendParts.join("\n\n")}\n\n---\n\n${prompt}`;
      await session.send(fullPrompt);
      let turn = await drainTurn(session);

      if (
        options.schema &&
        captured.length === 0 &&
        turn.success &&
        !signal.aborted
      ) {
        // Nudge once: the model answered in prose instead of calling the tool.
        await session.send(
          "You did not call the StructuredOutput tool. Call it now with your final result; its arguments must match the schema.",
        );
        const nudged = await drainTurn(session);
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
      session.close();
    }
  }

  /** Delete the ephemeral worker agent. Safe to call when none was created. */
  async cleanup(): Promise<void> {
    if (this.workerAgentId) {
      const agentId = this.workerAgentId;
      this.workerAgentId = null;
      this.workerAgentPromise = null;
      try {
        await this.client.agents.delete(agentId);
      } catch {
        // Leaked workers carry the letta-workflow:worker tag for manual cleanup.
      }
    }
  }
}
