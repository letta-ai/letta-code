/**
 * A persistent Repl session: one vm context whose globals survive across
 * cells, one lazily created subagent spawner, and a registry of steerable
 * workers. Cells see `tools.*` (programmatic tool calling), `agent()`,
 * `agent.start()`, `parallel()`, and `pipeline()`.
 *
 * Like the workflow engine, the vm context is not a security boundary: the
 * hooks are host-realm functions and cells run with the CLI's privileges.
 */

import { format } from "node:util";
import vm from "node:vm";
import {
  type ReplTurnRecord,
  ReplWorker,
  type ReplWorkerInfo,
} from "@/tools/repl/repl-worker";
import {
  createToolHooks,
  parallel,
  pipeline,
  type ScriptToolBindings,
  Semaphore,
} from "@/tools/workflow/script-hooks";
import type { AgentCallOptions, SubagentSpawner } from "@/tools/workflow/types";

const MAX_CONCURRENT_TOOL_CALLS = 16;
const MAX_SESSION_TOOL_CALLS = 10_000;
const MAX_BACKLOG_LOGS = 200;
const SESSION_ABORTED = "Repl session was reset.";

export interface ReplSpawnerHandle {
  spawner: SubagentSpawner;
  cleanup(): Promise<void>;
}

export interface ReplToolScope extends ScriptToolBindings {
  cleanup(): Promise<void>;
}

export interface ReplSessionDeps {
  createSpawner: () => Promise<ReplSpawnerHandle>;
  onWorkerSettled?: (worker: ReplWorker, turn: ReplTurnRecord) => void;
  /** Test-only continuation retry tuning. */
  workerRetryDelayMs?: number;
}

export interface ReplCellOptions {
  args?: unknown;
  signal?: AbortSignal;
  /** The invoking turn's tools; replaces the previous cell's bindings. */
  scope?: ReplToolScope;
  onLog?: (message: string) => void;
}

export interface ReplCellResult {
  result: unknown;
  output: string[];
}

interface ScopeEntry {
  scope: ReplToolScope;
  activeCells: number;
  replaced: boolean;
}

/** Bare names a cell can use to reach subagents; warm the spawner for them. */
const USES_AGENT = /\bagent\s*(?:\.\s*start\b|\()/;

function validateAgentOptions(callOptions: unknown): AgentCallOptions {
  if (
    callOptions !== undefined &&
    (!callOptions ||
      typeof callOptions !== "object" ||
      Array.isArray(callOptions))
  ) {
    throw new Error("agent() options must be an object.");
  }
  const opts = { ...(callOptions as AgentCallOptions | undefined) };
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
  return opts;
}

export class ReplSession {
  private readonly deps: ReplSessionDeps;
  private readonly context: vm.Context;
  private readonly workers = new Map<string, ReplWorker>();
  private readonly lifetime = new AbortController();
  private readonly logSinks: Array<(message: string) => void> = [];
  private backlog: string[] = [];
  private spawnerHandle: Promise<ReplSpawnerHandle> | undefined;
  private currentScope: ScopeEntry | null = null;
  private workerCounter = 0;
  private callCounter = 0;
  private cellCounter = 0;
  private activeCellCount = 0;
  private closed = false;
  private readonly toolHooksReset: () => void;

  constructor(deps: ReplSessionDeps) {
    this.deps = deps;
    const toolHooks = createToolHooks({
      bindings: () => this.currentScope?.scope ?? {},
      signal: () => this.lifetime.signal,
      semaphore: new Semaphore(MAX_CONCURRENT_TOOL_CALLS),
      maxTotalToolCalls: MAX_SESSION_TOOL_CALLS,
      track: (pending) => {
        void pending.catch(() => {});
        return pending;
      },
      abortedMessage: SESSION_ABORTED,
    });
    this.toolHooksReset = toolHooks.resetToolInfo;

    const start = (prompt: unknown, options?: unknown) =>
      this.startWorker(prompt, options);
    const agent = Object.assign(
      (prompt: unknown, options?: unknown) => start(prompt, options).result(),
      {
        start,
        get: (id: unknown) => this.findWorker(id),
        list: (): ReplWorkerInfo[] =>
          [...this.workers.values()].map((worker) => worker.info()),
      },
    );
    const log = (...messages: unknown[]) => this.log(format(...messages));
    this.context = vm.createContext({
      tools: toolHooks.tools,
      listTools: toolHooks.listTools,
      describeTool: toolHooks.describeTool,
      agent,
      parallel,
      pipeline,
      console: { log, warn: log, error: log, info: log },
    });
  }

  get activeCells(): number {
    return this.activeCellCount;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  workerInfo(): ReplWorkerInfo[] {
    return [...this.workers.values()].map((worker) => worker.info());
  }

  async runCell(
    code: string,
    options: ReplCellOptions = {},
  ): Promise<ReplCellResult> {
    if (this.closed) throw new Error(SESSION_ABORTED);
    const cellIndex = ++this.cellCounter;
    const output: string[] = [];
    const sink = (message: string) => {
      output.push(message);
      options.onLog?.(message);
    };
    for (const message of this.backlog.splice(0)) sink(message);
    this.logSinks.push(sink);
    this.activeCellCount++;
    const scopeEntry = options.scope ? this.adoptScope(options.scope) : null;
    const signal = options.signal ?? new AbortController().signal;
    let abortCell = () => {};
    try {
      // Create the spawner inside the invoking tool call, where the parent's
      // runtime context (model, tools, permissions) is current.
      if (USES_AGENT.test(code)) await this.getSpawner();
      // Sloppy mode on purpose: a bare assignment (`w = agent.start(...)`)
      // creates a context global that later cells can read. `args` is a
      // parameter so overlapping cells each keep their own.
      const wrapped = `(async (args) => {\n${code}\n})`;
      let script: vm.Script;
      try {
        script = new vm.Script(wrapped, {
          filename: `repl-cell-${cellIndex}.js`,
        });
      } catch (error) {
        throw new Error(
          `Repl cell failed to parse (cells are plain JavaScript, not TypeScript): ${String(error)}`,
        );
      }
      let pending: Promise<unknown>;
      try {
        // Node reports syntax errors at construction; Bun compiles lazily.
        const cell = script.runInContext(this.context) as (
          args: unknown,
        ) => Promise<unknown>;
        pending = Promise.resolve(cell(options.args));
      } catch (error) {
        if ((error as { name?: string }).name === "SyntaxError") {
          throw new Error(
            `Repl cell failed to parse (cells are plain JavaScript, not TypeScript): ${String(error)}`,
          );
        }
        throw error;
      }
      void pending.catch(() => {});
      const aborted = new Promise<never>((_resolve, reject) => {
        abortCell = () => reject(new Error("Repl cell aborted."));
        if (signal.aborted || this.lifetime.signal.aborted) abortCell();
        signal.addEventListener("abort", abortCell, { once: true });
        this.lifetime.signal.addEventListener("abort", abortCell, {
          once: true,
        });
      });
      void aborted.catch(() => {});
      const result = await Promise.race([pending, aborted]);
      return { result, output };
    } finally {
      signal.removeEventListener("abort", abortCell);
      this.lifetime.signal.removeEventListener("abort", abortCell);
      this.activeCellCount--;
      const index = this.logSinks.lastIndexOf(sink);
      if (index >= 0) this.logSinks.splice(index, 1);
      if (scopeEntry) this.releaseScope(scopeEntry);
    }
  }

  /** Stop every worker and release the spawner and tool scopes. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new Error(SESSION_ABORTED));
    await Promise.allSettled(
      [...this.workers.values()].map((worker) => worker.stop()),
    );
    const scope = this.currentScope;
    this.currentScope = null;
    await scope?.scope.cleanup().catch(() => undefined);
    const handle = this.spawnerHandle;
    this.spawnerHandle = undefined;
    await handle?.then((resolved) => resolved.cleanup()).catch(() => undefined);
  }

  private startWorker(prompt: unknown, callOptions?: unknown): ReplWorker {
    if (this.closed) throw new Error(SESSION_ABORTED);
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("agent() requires a non-empty prompt string.");
    }
    const options = validateAgentOptions(callOptions);
    if (options.conversationId) {
      const existing = this.findWorker(options.conversationId);
      if (existing) {
        throw new Error(
          `Conversation ${options.conversationId} is already worker ${existing.id}; use agent.get("${existing.id}").send(...).`,
        );
      }
    }
    const id = `w${++this.workerCounter}`;
    const worker = new ReplWorker(
      {
        id,
        getSpawner: async () => (await this.getSpawner()).spawner,
        nextCallIndex: () => this.callCounter++,
        onSettled: (settled, turn) =>
          this.deps.onWorkerSettled?.(settled, turn),
        ...(this.deps.workerRetryDelayMs !== undefined
          ? { retryDelayMs: this.deps.workerRetryDelayMs }
          : {}),
      },
      prompt,
      options,
    );
    this.workers.set(id, worker);
    return worker;
  }

  private findWorker(id: unknown): ReplWorker | undefined {
    if (typeof id !== "string") return undefined;
    const direct = this.workers.get(id);
    if (direct) return direct;
    for (const worker of this.workers.values()) {
      if (worker.conversationId === id || worker.label === id) return worker;
    }
    return undefined;
  }

  private getSpawner(): Promise<ReplSpawnerHandle> {
    if (this.closed) return Promise.reject(new Error(SESSION_ABORTED));
    this.spawnerHandle ??= this.deps.createSpawner().catch((error) => {
      this.spawnerHandle = undefined;
      throw error;
    });
    return this.spawnerHandle;
  }

  private log(message: string): void {
    const sink = this.logSinks.at(-1);
    if (sink) {
      sink(message);
      return;
    }
    // Output from work that outlived its cell surfaces in the next cell.
    this.backlog.push(message);
    if (this.backlog.length > MAX_BACKLOG_LOGS) this.backlog.shift();
  }

  private adoptScope(scope: ReplToolScope): ScopeEntry {
    const previous = this.currentScope;
    const entry: ScopeEntry = { scope, activeCells: 1, replaced: false };
    this.currentScope = entry;
    this.toolHooksReset();
    if (previous) {
      previous.replaced = true;
      if (previous.activeCells === 0) {
        void previous.scope.cleanup().catch(() => undefined);
      }
    }
    return entry;
  }

  private releaseScope(entry: ScopeEntry): void {
    entry.activeCells--;
    if (entry.replaced && entry.activeCells === 0) {
      void entry.scope.cleanup().catch(() => undefined);
    }
  }
}
