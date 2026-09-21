/**
 * The workflow engine: parses the meta block, builds the script-facing hooks
 * (agent / parallel / pipeline / phase / log / args), executes the script
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

import vm from "node:vm";
import { appendJournalEntry } from "./journal.ts";
import { parseWorkflowMeta, stripMetaExport } from "./meta.ts";
import type {
  AgentCallOptions,
  RunWorkflowOptions,
  SubagentSpawner,
  WorkflowExecutionResult,
  WorkflowProgressEvent,
} from "./types.ts";

export const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_MAX_TOTAL_AGENTS = 1000;
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

function defaultLabel(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 45)}...`;
}

export async function executeWorkflow(
  spawner: SubagentSpawner,
  options: RunWorkflowOptions,
): Promise<WorkflowExecutionResult> {
  const meta = parseWorkflowMeta(options.script);
  const signal = options.signal ?? new AbortController().signal;
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
  const semaphore = new Semaphore(
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  );

  let currentPhase: string | null = null;
  let callCounter = 0;
  let agentsSpawned = 0;
  let totalTokens = 0;

  function agent(prompt: unknown, callOptions?: unknown): Promise<unknown> {
    const pending = callAgent(prompt, callOptions);
    // Scripts can forget to await a call; that must not surface as an
    // unhandled rejection. Awaiting it still observes the original error.
    void pending.catch(() => {});
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending)).catch(() => {});
    return pending;
  }

  async function callAgent(
    prompt: unknown,
    callOptions?: unknown,
  ): Promise<unknown> {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("agent() requires a non-empty prompt string.");
    }
    if (signal.aborted) throw new Error("Workflow aborted.");
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
      opts.maxToolCalls !== undefined &&
      (!Number.isSafeInteger(opts.maxToolCalls) || opts.maxToolCalls <= 0)
    ) {
      throw new Error("agent() maxToolCalls must be a positive safe integer.");
    }
    const callIndex = callCounter++;
    const label = opts.label ?? defaultLabel(prompt);
    const phase = opts.phase ?? currentPhase;

    emit({ kind: "agent", callIndex, label, phase, status: "queued" });
    await semaphore.acquire();
    try {
      if (signal.aborted) throw new Error("Workflow aborted.");
      emit({ kind: "agent", callIndex, label, phase, status: "running" });
      agentsSpawned++;
      const outcome = await spawner(
        { prompt, options: opts, callIndex },
        signal,
      );
      // Account for the outcome even when the run was aborted meanwhile: the
      // spawner returns what the interrupted subagent had already consumed.
      totalTokens += outcome.totalTokens ?? 0;
      if (options.journalPath) {
        appendJournalEntry(options.journalPath, {
          callIndex,
          label,
          prompt,
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
      if (signal.aborted) throw new Error("Workflow aborted.");
      return outcome.failed ? null : outcome.value;
    } finally {
      semaphore.release();
    }
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
    return Promise.all(
      thunks.map(async (thunk) => {
        if (typeof thunk !== "function") return null;
        try {
          return await thunk();
        } catch {
          return null;
        }
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
    // No barrier between stages: each item flows through its whole chain
    // independently, so item A can be in stage 3 while item B is in stage 1.
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stageFns) {
          try {
            value = await stage(value, item, index);
          } catch {
            return null;
          }
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

  function log(message: unknown): void {
    emit({ kind: "log", message: String(message) });
  }

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    phase,
    log,
    args: options.args,
    console: { log, warn: log, error: log, info: log },
  });
  const wrapped = `(async () => { "use strict";\n${stripMetaExport(options.script)}\n})()`;
  const parseError = (error: unknown) =>
    new Error(
      `Workflow script failed to parse (scripts are plain JavaScript, not TypeScript): ${String(error)}`,
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
    if (signal.aborted) reject(new Error("Workflow aborted."));
    signal.addEventListener(
      "abort",
      () => reject(new Error("Workflow aborted.")),
      { once: true },
    );
  });
  void abortRun.catch(() => {});
  // Whether the script returned, threw, or was aborted, wait for every
  // launched subagent to report back before settling. Aborted ones return
  // promptly because the spawner honors the signal.
  const drain = async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };
  try {
    const result = await Promise.race([pending, abortRun]);
    await drain();
    return { meta, result, agentsSpawned, totalTokens };
  } catch (error) {
    await drain();
    throw error;
  } finally {
    settled = true;
  }
}
