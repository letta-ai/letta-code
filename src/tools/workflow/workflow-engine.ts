/**
 * The workflow engine: parses the meta block, builds the script-facing hooks
 * (agent / decide / tools / parallel / pipeline / phase / log / args), executes the script
 * body inside a node:vm context, and appends every subagent outcome to the
 * run's journal.
 *
 * The engine is deliberately small: it schedules calls to the injected
 * spawner and nothing else. Everything a subagent does happens in the
 * spawner (sdk-spawner.ts in production).
 *
 * The vm context gives the script a clean global scope with only the hooks
 * in it. It is not a security boundary: the hooks are host-realm functions,
 * so a script can reach the host through them (node:vm documents this). The
 * script runs with the CLI's own privileges, like the Bash tool; the
 * approval prompt shows its source so the user approves what actually runs.
 */

import { format } from "node:util";
import vm from "node:vm";
import { submitWorkflowDecision } from "./decide.ts";
import { formatUsd } from "./format-stats.ts";
import { appendJournalEntry } from "./journal.ts";
import { parseWorkflowMeta, stripMetaExport } from "./meta.ts";
import {
  createToolHooks,
  parallel,
  pipeline,
  Semaphore,
} from "./script-hooks.ts";
import type {
  AgentCallOptions,
  RunWorkflowOptions,
  SubagentSpawner,
  WorkflowExecutionResult,
  WorkflowMeta,
  WorkflowProgressEvent,
} from "./types.ts";

export const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_MAX_TOTAL_AGENTS = 1000;
const DEFAULT_MAX_TOTAL_DECISIONS = 1000;
const DEFAULT_MAX_TOTAL_TOOL_CALLS = 1000;
function defaultLabel(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 45)}...`;
}

export async function executeWorkflow(
  spawner: SubagentSpawner,
  options: RunWorkflowOptions,
): Promise<WorkflowExecutionResult> {
  const meta = parseWorkflowMeta(options.script);
  return executeScript(spawner, options, meta);
}

/** The same tool bindings, decide(), and call limits, without metadata or agent orchestration. */
export async function executeToolScript(
  options: Pick<
    RunWorkflowOptions,
    | "script"
    | "args"
    | "signal"
    | "callTool"
    | "builtinToolNames"
    | "listTools"
    | "onProgress"
    | "env"
    | "maxTotalToolCalls"
    | "maxTotalDecisions"
  > & {
    /** Extra script globals, e.g. Monitor's `emit` and `sleep`. */
    globals?: Record<string, unknown>;
  },
): Promise<unknown> {
  const run = await executeScript(
    undefined,
    options,
    { name: "code-mode", description: "Combine tools with JavaScript" },
    options.globals,
  );
  return run.result;
}

async function executeScript(
  spawner: SubagentSpawner | undefined,
  options: RunWorkflowOptions,
  meta: WorkflowMeta,
  extraGlobals?: Record<string, unknown>,
): Promise<WorkflowExecutionResult> {
  // The budget stops the run through its own controller so every cut point
  // reports the budget error rather than a bare abort.
  const budgetController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, budgetController.signal])
    : budgetController.signal;
  const maxCostUsd = options.maxCostUsd;
  let budgetError: Error | undefined;
  const abortError = () => budgetError ?? new Error("Workflow aborted.");
  // Progress stops once the run has settled, not at abort: an interrupted
  // subagent still reports its outcome (and tokens) while the run drains.
  let settled = false;
  const emit = (event: WorkflowProgressEvent) => {
    if (!settled) options.onProgress?.(event);
  };
  // Every agent() call, awaited by the script or not. The run does not
  // settle until all of them have, so a completion never precedes a worker.
  const inFlight = new Set<Promise<unknown>>();
  const maxTotalAgents = options.maxTotalAgents ?? DEFAULT_MAX_TOTAL_AGENTS;
  const maxTotalDecisions =
    options.maxTotalDecisions ?? DEFAULT_MAX_TOTAL_DECISIONS;
  const maxTotalToolCalls =
    options.maxTotalToolCalls ?? DEFAULT_MAX_TOTAL_TOOL_CALLS;
  const semaphore = new Semaphore(
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  );

  let currentPhase: string | null = null;
  let callCounter = 0;
  let decisionCounter = 0;
  let agentsSpawned = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let costUnavailable = false;

  function stopForBudget(message: string, code: string): void {
    if (budgetError) return;
    budgetError = Object.assign(new Error(message), { code });
    budgetController.abort(budgetError);
  }

  function chargeCost(deltaUsd: number): void {
    totalCostUsd += deltaUsd;
    if (maxCostUsd !== undefined && totalCostUsd >= maxCostUsd) {
      stopForBudget(
        `Workflow cost budget of ${formatUsd(maxCostUsd)} reached.`,
        "budget_exceeded",
      );
    }
  }

  /** A budget the run cannot measure is not enforced silently: stop instead. */
  function markCostUnavailable(source: string): void {
    costUnavailable = true;
    if (maxCostUsd !== undefined) {
      stopForBudget(
        `Workflow cost budget cannot be enforced: ${source} reported usage without a cost estimate.`,
        "cost_unavailable",
      );
    }
  }

  /** Tracks one subagent's cumulative cost so live and final reports never double-count. */
  function agentCostMeter(label: string) {
    let charged = 0;
    let unavailable = false;
    return (costUsd: number | null | undefined) => {
      if (costUsd === undefined || unavailable) return;
      if (costUsd === null) {
        unavailable = true;
        markCostUnavailable(`agent "${label}"`);
        return;
      }
      if (costUsd > charged) {
        chargeCost(costUsd - charged);
        charged = costUsd;
      }
    };
  }

  const budget = Object.freeze({
    get limit() {
      return maxCostUsd ?? null;
    },
    /** Null once any usage was unpriced, matching `totalCostUsd`. */
    get spent() {
      return costUnavailable ? null : totalCostUsd;
    },
    get remaining() {
      return maxCostUsd === undefined || costUnavailable
        ? null
        : Math.max(0, maxCostUsd - totalCostUsd);
    },
  });

  function trackCall<T>(pending: Promise<T>): Promise<T> {
    // Scripts can forget to await a call; that must not surface as an
    // unhandled rejection. Awaiting it still observes the original error.
    void pending.catch(() => {});
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending)).catch(() => {});
    return pending;
  }

  function agent(prompt: unknown, callOptions?: unknown): Promise<unknown> {
    return trackCall(callAgent(prompt, callOptions));
  }

  function decide(
    state: unknown,
    questions: unknown,
    callOptions?: unknown,
  ): Promise<unknown> {
    return trackCall(callDecision(state, questions, callOptions));
  }

  const toolHooks = createToolHooks({
    bindings: () => options,
    signal: () => signal,
    semaphore,
    maxTotalToolCalls,
    track: trackCall,
    journalPath: options.journalPath,
    abortError,
  });

  async function callDecision(
    state: unknown,
    questions: unknown,
    callOptions?: unknown,
  ): Promise<unknown> {
    if (signal.aborted) throw abortError();
    if (decisionCounter >= maxTotalDecisions) {
      throw new Error(`Lifetime decision cap of ${maxTotalDecisions} reached.`);
    }
    if (
      callOptions !== undefined &&
      (!callOptions ||
        typeof callOptions !== "object" ||
        Array.isArray(callOptions))
    ) {
      throw new Error("decide() options must be an object.");
    }
    decisionCounter++;
    await semaphore.acquire();
    try {
      if (signal.aborted) throw abortError();
      return await submitWorkflowDecision(
        {
          ...(callOptions as Record<string, unknown> | undefined),
          state,
          questions,
        },
        signal,
        (result) => {
          totalTokens += result.totalTokens;
          if (typeof result.cost === "number" && Number.isFinite(result.cost)) {
            chargeCost(result.cost);
          } else {
            markCostUnavailable("decide()");
          }
          emit({ kind: "decision_usage", totalTokens: result.totalTokens });
          if (options.journalPath) {
            appendJournalEntry(options.journalPath, {
              kind: "decision",
              ...result,
            });
          }
        },
      );
    } finally {
      semaphore.release();
    }
  }

  async function callAgent(
    prompt: unknown,
    callOptions?: unknown,
  ): Promise<unknown> {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("agent() requires a non-empty prompt string.");
    }
    if (signal.aborted) throw abortError();
    if (callCounter >= maxTotalAgents) {
      throw new Error(`Lifetime agent cap of ${maxTotalAgents} reached.`);
    }
    if (
      callOptions !== undefined &&
      (!callOptions ||
        typeof callOptions !== "object" ||
        Array.isArray(callOptions))
    ) {
      throw new Error("agent() options must be an object.");
    }
    const opts: AgentCallOptions = { ...(callOptions as AgentCallOptions) };
    if (
      opts.conversationId !== undefined &&
      (typeof opts.conversationId !== "string" ||
        !/^(?:conv-|local-conv-)[A-Za-z0-9_-]+$/.test(opts.conversationId))
    ) {
      throw new Error(
        "agent() conversationId must be a conv-... or local-conv-... ID.",
      );
    }
    if (
      opts.maxToolCalls !== undefined &&
      (!Number.isSafeInteger(opts.maxToolCalls) || opts.maxToolCalls <= 0)
    ) {
      throw new Error("agent() maxToolCalls must be a positive safe integer.");
    }
    if (
      opts.skills !== undefined &&
      (!Array.isArray(opts.skills) ||
        !opts.skills.every((id) => typeof id === "string" && id.trim()))
    ) {
      throw new Error("agent() skills must be an array of skill names.");
    }
    const callIndex = callCounter++;
    const label = opts.label ?? defaultLabel(prompt);
    const phase = opts.phase ?? currentPhase;

    emit({ kind: "agent", callIndex, label, phase, status: "queued" });
    const meterCost = agentCostMeter(label);
    await semaphore.acquire();
    try {
      if (signal.aborted) throw abortError();
      emit({ kind: "agent", callIndex, label, phase, status: "running" });
      agentsSpawned++;
      if (!spawner)
        throw new Error("Subagents are unavailable in tool scripts.");
      const outcome = await spawner(
        { prompt, options: opts, callIndex },
        signal,
        {
          onStarted: (conversationId) => {
            if (options.journalPath) {
              appendJournalEntry(options.journalPath, {
                kind: "agent_started",
                callIndex,
                conversationId,
              });
            }
          },
          // Live usage so status rows can show tokens before the agent ends.
          onUsage: (totalTokens, costUsd) => {
            meterCost(costUsd);
            emit({
              kind: "agent",
              callIndex,
              label,
              phase,
              status: "running",
              totalTokens,
            });
          },
        },
      );
      // Account for the outcome even when the run was aborted meanwhile: the
      // spawner returns what the interrupted subagent had already consumed.
      totalTokens += outcome.totalTokens ?? 0;
      meterCost(outcome.costUsd);
      if (options.journalPath) {
        appendJournalEntry(options.journalPath, {
          callIndex,
          label,
          prompt,
          ...(opts.conversationId
            ? { resumedConversationId: opts.conversationId }
            : {}),
          outcome,
        });
      }
      emit({
        kind: "agent",
        callIndex,
        label,
        phase,
        status: outcome.failed ? "error" : "done",
        detail: outcome.error,
        durationMs: outcome.durationMs,
        totalTokens: outcome.totalTokens,
      });
      if (signal.aborted) throw abortError();
      if (outcome.failed) {
        const worker = outcome.conversationId
          ? ` (${outcome.conversationId})`
          : "";
        throw Object.assign(
          new Error(
            `Workflow agent "${label}"${worker} failed: ${outcome.error ?? "unknown error"}`,
          ),
          { callIndex, conversationId: outcome.conversationId },
        );
      }
      return outcome.value;
    } finally {
      semaphore.release();
    }
  }

  function phase(title: unknown): void {
    if (typeof title !== "string" || !title) {
      throw new Error("phase() requires a title string.");
    }
    currentPhase = title;
    emit({ kind: "phase", title });
  }

  function log(...messages: unknown[]): void {
    emit({ kind: "log", message: format(...messages) });
  }

  const context = vm.createContext({
    tools: toolHooks.tools,
    listTools: toolHooks.listTools,
    describeTool: toolHooks.describeTool,
    decide,
    ...(spawner ? { agent, parallel, pipeline, phase, log, budget } : {}),
    args: options.args,
    console: { log, warn: log, error: log, info: log },
    // Only `env`: the host process's exit, kill, and bindings stay out.
    process: Object.freeze({ env: Object.freeze({ ...options.env }) }),
    ...extraGlobals,
  });
  const wrapped = `(async () => { "use strict";\n${spawner ? stripMetaExport(options.script) : options.script}\n})()`;
  const parseError = (error: unknown) =>
    new Error(
      `${spawner ? "Workflow" : "CodeMode"} script failed to parse (scripts are plain JavaScript, not TypeScript): ${String(error)}`,
    );
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: `${meta.name}.workflow.js` });
  } catch (error) {
    throw parseError(error);
  }

  let pending: Promise<unknown>;
  try {
    // Node reports syntax errors at construction; Bun compiles lazily, so
    // they can surface here instead.
    pending = script.runInContext(context) as Promise<unknown>;
  } catch (error) {
    if ((error as { name?: string }).name === "SyntaxError") {
      throw parseError(error);
    }
    throw error;
  }

  const abortRun = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), {
      once: true,
    });
  });
  void abortRun.catch(() => {});
  // Whether the script returned, threw, or was aborted, wait for every
  // launched subagent to report back before settling. Aborted ones return
  // promptly because the spawner honors the signal.
  const drain = async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };
  const runCost = () => (costUnavailable ? null : totalCostUsd);
  try {
    const result = await Promise.race([pending, abortRun]);
    await drain();
    return {
      meta,
      result,
      agentsSpawned,
      totalTokens,
      totalCostUsd: runCost(),
    };
  } catch (error) {
    await drain();
    // Report the final spend: the spawner holds each interrupt until a model
    // request already in flight reports its usage, so the drain meters it.
    if (
      budgetError &&
      error === budgetError &&
      maxCostUsd !== undefined &&
      !costUnavailable
    ) {
      budgetError.message = `${budgetError.message} ${formatUsd(totalCostUsd)} spent of ${formatUsd(maxCostUsd)}.${
        options.journalPath
          ? ` Completed calls are in ${options.journalPath}.`
          : ""
      }`;
    }
    throw error;
  } finally {
    settled = true;
  }
}
