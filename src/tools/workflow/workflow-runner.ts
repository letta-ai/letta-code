/**
 * The workflow engine: parses the meta block, builds the script-facing hooks
 * (agent / parallel / pipeline / phase / log / args / budget), executes the
 * script body inside a node:vm sandbox, and journals every subagent outcome
 * for resume.
 *
 * Scripts are plain JavaScript. Date.now(), argless new Date(), and
 * Math.random() are blocked inside the sandbox because replayed results must
 * be reproducible for resume to work.
 */

import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import vm from "node:vm";
import { defaultRunsDir, newRunId, RunJournal } from "./journal.ts";
import { parseWorkflowMeta, stripMetaExport } from "./meta.ts";
import { agentCallCacheKey, Semaphore } from "./scheduling.ts";
import type {
  AgentCallOptions,
  RunWorkflowOptions,
  SubagentSpawner,
  WorkflowBudget,
  WorkflowProgressEvent,
  WorkflowRunResult,
} from "./types.ts";

const DETERMINISM_PRELUDE = `(() => {
  const blocked = (name) => () => {
    throw new Error(name + " is not available in workflow scripts (it would break resume); pass timestamps in via args, and vary prompts by index for randomness.");
  };
  Math.random = blocked("Math.random()");
  const NativeDate = Date;
  const BlockedDate = new Proxy(NativeDate, {
    construct(target, argsList, newTarget) {
      if (argsList.length === 0) blocked("argless new Date()")();
      return Reflect.construct(target, argsList, newTarget);
    },
    apply() { return blocked("Date()")(); },
  });
  NativeDate.now = blocked("Date.now()");
  globalThis.Date = BlockedDate;
})();`;

function defaultLabel(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 45)}...`;
}

function normalizeOptionsForCache(options: AgentCallOptions): unknown {
  // label and phase are display-only; excluding them lets cosmetic edits
  // keep cache hits on resume.
  const { label: _label, phase: _phase, ...rest } = options;
  return rest;
}

export async function runWorkflow(
  spawner: SubagentSpawner,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const meta = parseWorkflowMeta(options.script);
  const runId = newRunId();
  const runsDir = options.runsDir ?? defaultRunsDir();
  const journal = new RunJournal(runsDir, runId);
  journal.persistScript(options.script, options.args);
  if (options.resumeFromRunId) {
    journal.loadReplayCache(runsDir, options.resumeFromRunId);
  }

  const emit = (event: WorkflowProgressEvent) => options.onProgress?.(event);
  const abortController = new AbortController();
  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) abortController.abort(externalSignal.reason);
    else
      externalSignal.addEventListener(
        "abort",
        () => abortController.abort(externalSignal.reason),
        { once: true },
      );
  }
  const signal = abortController.signal;

  const maxConcurrent =
    options.maxConcurrent ?? Math.min(16, Math.max(1, cpus().length - 2));
  const maxTotalAgents = options.maxTotalAgents ?? 1000;
  const semaphore = new Semaphore(maxConcurrent);

  let currentPhase: string | null = null;
  let callCounter = 0;
  let agentsSpawned = 0;
  let cacheHits = 0;
  let spentUsd = 0;
  const occurrences = new Map<string, number>();

  const budget: WorkflowBudget = {
    totalUsd: options.budgetUsd ?? null,
    spentUsd: () => spentUsd,
    remainingUsd: () =>
      options.budgetUsd == null
        ? Infinity
        : Math.max(0, options.budgetUsd - spentUsd),
  };

  async function agent(
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
    if (options.budgetUsd != null && spentUsd >= options.budgetUsd) {
      throw new Error(
        `Budget of $${options.budgetUsd} exhausted ($${spentUsd.toFixed(4)} spent).`,
      );
    }
    const opts: AgentCallOptions =
      callOptions && typeof callOptions === "object"
        ? ({ ...callOptions } as AgentCallOptions)
        : {};
    const callIndex = callCounter++;
    const label = opts.label ?? defaultLabel(prompt);
    const phase = opts.phase ?? currentPhase;
    const cacheKey = agentCallCacheKey(prompt, normalizeOptionsForCache(opts));
    const occurrence = occurrences.get(cacheKey) ?? 0;
    occurrences.set(cacheKey, occurrence + 1);

    const cached = journal.replay(cacheKey, occurrence);
    if (cached) {
      cacheHits++;
      journal.record({
        kind: "agent",
        cacheKey,
        occurrence,
        label,
        prompt,
        outcome: cached,
      });
      emit({ kind: "agent", callIndex, label, phase, status: "cached" });
      return cached.value;
    }

    emit({ kind: "agent", callIndex, label, phase, status: "queued" });
    await semaphore.acquire();
    try {
      if (signal.aborted) throw new Error("Workflow aborted.");
      emit({ kind: "agent", callIndex, label, phase, status: "running" });
      agentsSpawned++;
      const outcome = await spawner(
        { prompt, options: opts, cacheKey, occurrence, callIndex },
        signal,
      );
      spentUsd += outcome.costUsd ?? 0;
      journal.record({
        kind: "agent",
        cacheKey,
        occurrence,
        label,
        prompt,
        outcome,
      });
      emit({
        kind: "agent",
        callIndex,
        label,
        phase,
        status: outcome.failed ? "error" : "done",
        detail: outcome.error,
      });
      return outcome.failed ? null : outcome.value;
    } finally {
      semaphore.release();
    }
  }

  async function parallel(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel() takes an array of zero-arg functions.");
    }
    if (thunks.length > 4096) {
      throw new Error(
        `parallel() accepts at most 4096 items, got ${thunks.length}.`,
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
    if (items.length > 4096) {
      throw new Error(
        `pipeline() accepts at most 4096 items, got ${items.length}.`,
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

  function sleep(ms: unknown): Promise<void> {
    const delay = typeof ms === "number" && ms >= 0 ? ms : 0;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  function executeScript(
    scriptSource: string,
    scriptArgs: unknown,
    depth: number,
    scriptName: string,
  ): Promise<unknown> {
    // Child workflows share this run's hooks, semaphore, budget, journal,
    // and abort signal — their agents count toward the same caps and their
    // cached results live in the same journal. Nesting is one level only.
    async function workflowHook(
      nameOrRef: unknown,
      childArgs?: unknown,
    ): Promise<unknown> {
      if (depth >= 1) {
        throw new Error("workflow() nesting is one level only.");
      }
      const scriptPath =
        typeof nameOrRef === "string"
          ? nameOrRef
          : (nameOrRef as { scriptPath?: string } | null)?.scriptPath;
      if (!scriptPath) {
        throw new Error(
          "workflow() takes a script path string or {scriptPath}.",
        );
      }
      let childScript: string;
      try {
        childScript = readFileSync(scriptPath, "utf8");
      } catch (error) {
        throw new Error(
          `workflow(): cannot read ${scriptPath}: ${String(error)}`,
        );
      }
      const childMeta = parseWorkflowMeta(childScript);
      emit({ kind: "log", message: `▸ child workflow ${childMeta.name}` });
      return executeScript(childScript, childArgs, depth + 1, childMeta.name);
    }

    const context = vm.createContext({
      agent,
      parallel,
      pipeline,
      phase,
      log,
      sleep,
      workflow: workflowHook,
      args: scriptArgs,
      budget,
      console: { log, warn: log, error: log, info: log },
    });
    vm.runInContext(DETERMINISM_PRELUDE, context);

    const body = stripMetaExport(scriptSource);
    const wrapped = `(async () => { "use strict";\n${body}\n})()`;
    let script: vm.Script;
    try {
      script = new vm.Script(wrapped, {
        filename: `${scriptName}.workflow.js`,
      });
    } catch (error) {
      throw new Error(`Workflow script failed to parse: ${String(error)}`);
    }

    try {
      // Under Bun, vm.Script compiles lazily, so syntax errors (e.g.
      // TypeScript annotations in what must be plain JS) surface here.
      return script.runInContext(context) as Promise<unknown>;
    } catch (error) {
      if ((error as { name?: string }).name === "SyntaxError") {
        throw new Error(
          `Workflow script failed to parse (scripts are plain JavaScript, not TypeScript): ${String(error)}`,
        );
      }
      throw error;
    }
  }

  const result = await executeScript(
    options.script,
    options.args,
    0,
    meta.name,
  );

  return {
    runId,
    meta,
    result,
    runDir: journal.runDir,
    agentsSpawned,
    cacheHits,
    totalCostUsd: spentUsd,
  };
}
