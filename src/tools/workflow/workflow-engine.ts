import { format } from "node:util";
import vm from "node:vm";
import { submitWorkflowDecision } from "./decide.ts";
import { formatUsd } from "./format-stats.ts";
import { appendJournalEntry } from "./journal.ts";
import { parseWorkflowMeta, stripMetaExport } from "./meta.ts";
import type {
  AgentCallOptions,
  RunWorkflowOptions,
  SubagentSpawner,
  WorkflowExecutionResult,
  WorkflowMeta,
  WorkflowProgressEvent,
  WorkflowToolInfo,
  WorkflowToolResult,
} from "./types.ts";

export const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_MAX_TOTAL_AGENTS = 1000;
const DEFAULT_MAX_TOTAL_DECISIONS = 1000;
const DEFAULT_MAX_TOTAL_TOOL_CALLS = 1000;
const MAX_ITEMS_PER_HELPER = 4096;

class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(slots: number) {
    this.available = Math.max(1, slots);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}

function mcpText(content: unknown[]): string[] {
  return content.flatMap((part) =>
    part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  );
}

function mcpContentValue(content: unknown[]): unknown {
  const text = mcpText(content);
  if (text.length !== content.length || text.length === 0) return content;
  const joined = text.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

function mcpErrorText(result: { content: unknown[] }): string {
  return mcpText(result.content).join("\n").slice(0, 2000) || "MCP tool error";
}

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
  const budgetController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, budgetController.signal])
    : budgetController.signal;
  const maxCostUsd = options.maxCostUsd;
  let budgetError: Error | undefined;
  const abortError = () => budgetError ?? new Error("Workflow aborted.");
  let settled = false;
  const emit = (event: WorkflowProgressEvent) => {
    if (!settled) options.onProgress?.(event);
  };
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
  let toolCallCounter = 0;
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

  function markCostUnavailable(source: string): void {
    costUnavailable = true;
    if (maxCostUsd !== undefined) {
      stopForBudget(
        `Workflow cost budget cannot be enforced: ${source} reported usage without a cost estimate.`,
        "cost_unavailable",
      );
    }
  }

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

  const builtinToolNames = new Set(options.builtinToolNames ?? []);
  const isCallable = (name: string) =>
    builtinToolNames.has(name) || name.startsWith("mcp__");
  const tools = new Proxy(Object.freeze({}), {
    get: (_target, name) =>
      typeof name === "string" && isCallable(name)
        ? (args?: unknown) => trackCall(callTool(name, args))
        : undefined,
  });

  let toolInfo: Promise<WorkflowToolInfo[]> | undefined;
  function loadToolInfo(): Promise<WorkflowToolInfo[]> {
    if (!options.listTools) return Promise.resolve([]);
    toolInfo ??= options.listTools().catch((error: unknown) => {
      toolInfo = undefined;
      throw error;
    });
    return toolInfo;
  }

  async function listTools(): Promise<
    Array<{ name: string; description: string }>
  > {
    return (await loadToolInfo()).map(({ name, description }) => ({
      name,
      description,
    }));
  }

  async function describeTool(
    name: unknown,
  ): Promise<WorkflowToolInfo | undefined> {
    if (typeof name !== "string" || !name) {
      throw new Error("describeTool() requires a tool name string.");
    }
    return (await loadToolInfo()).find((tool) => tool.name === name);
  }

  async function callTool(toolName: string, args?: unknown): Promise<unknown> {
    const call = options.callTool;
    if (!call) {
      throw new Error("tools are unavailable: no invoking tool scope.");
    }
    if (
      args !== undefined &&
      (!args || typeof args !== "object" || Array.isArray(args))
    ) {
      throw new Error(`tools.${toolName}() arguments must be an object.`);
    }
    if (signal.aborted) throw abortError();
    if (toolCallCounter >= maxTotalToolCalls) {
      throw new Error(
        `Lifetime tool call cap of ${maxTotalToolCalls} reached.`,
      );
    }
    toolCallCounter++;
    await semaphore.acquire();
    const startedAt = Date.now();
    const journal = (isError: boolean, error?: string) => {
      if (!options.journalPath) return;
      appendJournalEntry(options.journalPath, {
        kind: "tool_call",
        toolName,
        isError,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
    };
    let result: WorkflowToolResult;
    try {
      if (signal.aborted) throw abortError();
      result = await call(toolName, (args ?? {}) as Record<string, unknown>);
    } catch (error) {
      journal(true, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      semaphore.release();
    }
    if (result.isError) {
      const message = mcpErrorText(result);
      journal(true, message);
      throw new Error(`${toolName} failed: ${message}`);
    }
    journal(false);
    if (builtinToolNames.has(toolName))
      return mcpText(result.content).join("\n");
    return result.structuredContent ?? mcpContentValue(result.content);
  }

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

  async function collectResults(tasks: Promise<unknown>[]): Promise<unknown[]> {
    const outcomes = await Promise.allSettled(tasks);
    return outcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
  }

  async function parallel(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel() takes an array of zero-arg functions.");
    }
    if (thunks.length > MAX_ITEMS_PER_HELPER) {
      throw new Error(
        `parallel() accepts at most ${MAX_ITEMS_PER_HELPER} items, got ${thunks.length}.`,
      );
    }
    return collectResults(
      thunks.map(async (thunk) => {
        if (typeof thunk !== "function") {
          throw new Error("parallel() takes an array of zero-arg functions.");
        }
        return await thunk();
      }),
    );
  }

  async function pipeline(
    items: unknown,
    ...stages: unknown[]
  ): Promise<unknown[]> {
    if (!Array.isArray(items)) {
      throw new Error(
        "pipeline() takes an array of items followed by stage functions.",
      );
    }
    if (items.length > MAX_ITEMS_PER_HELPER) {
      throw new Error(
        `pipeline() accepts at most ${MAX_ITEMS_PER_HELPER} items, got ${items.length}.`,
      );
    }
    type StageFn = (prev: unknown, item: unknown, index: number) => unknown;
    const stageFns = stages.filter(
      (s): s is StageFn => typeof s === "function",
    );
    return collectResults(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stageFns) {
          value = await stage(value, item, index);
        }
        return value;
      }),
    );
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
    tools,
    listTools,
    describeTool,
    decide,
    ...(spawner ? { agent, parallel, pipeline, phase, log, budget } : {}),
    args: options.args,
    console: { log, warn: log, error: log, info: log },
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
