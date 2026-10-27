/**
 * Script-facing hooks shared by the workflow engine and the Repl tool: the
 * `tools` proxy, `listTools()`, `describeTool()`, `parallel()`, and
 * `pipeline()`. Orchestration hooks with run-specific lifecycles (agent,
 * decide) stay with their owners.
 */

import { appendJournalEntry } from "./journal.ts";
import type {
  WorkflowToolCaller,
  WorkflowToolInfo,
  WorkflowToolResult,
} from "./types.ts";

export const MAX_ITEMS_PER_HELPER = 4096;

export class Semaphore {
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

/** Text results resolve to a string (parsed when JSON); others stay raw. */
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

/** The invoking turn's tool bindings. Read on every call, so owners may swap them. */
export interface ScriptToolBindings {
  callTool?: WorkflowToolCaller;
  builtinToolNames?: readonly string[];
  listTools?: () => Promise<WorkflowToolInfo[]>;
  /** Backs `memory.open(target)`; see tools/memory-handle. */
  openMemory?: (target: unknown) => Promise<unknown>;
}

export interface ToolHooksConfig {
  bindings: () => ScriptToolBindings;
  signal: () => AbortSignal;
  semaphore: Semaphore;
  maxTotalToolCalls: number;
  /** Registers each call so its owner can drain or guard it. */
  track: <T>(pending: Promise<T>) => Promise<T>;
  journalPath?: string;
  abortedMessage: string;
}

export interface ToolHooks {
  tools: object;
  memory: object;
  harness: object;
  listTools(): Promise<Array<{ name: string; description: string }>>;
  describeTool(name: unknown): Promise<WorkflowToolInfo | undefined>;
  /** Forget cached tool metadata after the bindings change. */
  resetToolInfo(): void;
}

export function createToolHooks(config: ToolHooksConfig): ToolHooks {
  let toolCallCounter = 0;
  const isBuiltin = (name: string) =>
    (config.bindings().builtinToolNames ?? []).includes(name);
  const isCallable = (name: string) =>
    isBuiltin(name) || name.startsWith("mcp__");

  // Codex-style `tools` global: `await tools.Read(args)` or
  // `await tools.mcp__server__tool(args)`. Only the invoking turn's built-ins
  // and agent MCP tools are exposed; any other name is undefined.
  const tools = new Proxy(Object.freeze({}), {
    get: (_target, name) =>
      typeof name === "string" && isCallable(name)
        ? (args?: unknown) => config.track(callTool(name, args))
        : undefined,
  });

  let toolInfo: Promise<WorkflowToolInfo[]> | undefined;
  function loadToolInfo(): Promise<WorkflowToolInfo[]> {
    const list = config.bindings().listTools;
    if (!list) return Promise.resolve([]);
    toolInfo ??= list().catch((error: unknown) => {
      toolInfo = undefined;
      throw error;
    });
    return toolInfo;
  }

  async function callTool(toolName: string, args?: unknown): Promise<unknown> {
    const call = config.bindings().callTool;
    if (!call) {
      throw new Error("tools are unavailable: no invoking tool scope.");
    }
    if (
      args !== undefined &&
      (!args || typeof args !== "object" || Array.isArray(args))
    ) {
      throw new Error(`tools.${toolName}() arguments must be an object.`);
    }
    const signal = config.signal();
    if (signal.aborted) throw new Error(config.abortedMessage);
    if (toolCallCounter >= config.maxTotalToolCalls) {
      throw new Error(
        `Lifetime tool call cap of ${config.maxTotalToolCalls} reached.`,
      );
    }
    toolCallCounter++;
    await config.semaphore.acquire();
    const startedAt = Date.now();
    const journal = (isError: boolean, error?: string) => {
      if (!config.journalPath) return;
      appendJournalEntry(config.journalPath, {
        kind: "tool_call",
        toolName,
        isError,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
    };
    let result: WorkflowToolResult;
    try {
      if (signal.aborted) throw new Error(config.abortedMessage);
      result = await call(toolName, (args ?? {}) as Record<string, unknown>);
    } catch (error) {
      journal(true, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      config.semaphore.release();
    }
    if (result.isError) {
      const message = mcpErrorText(result);
      journal(true, message);
      throw new Error(`${toolName} failed: ${message}`);
    }
    journal(false);
    // Built-ins resolve to their text output verbatim; MCP results normalize.
    if (isBuiltin(toolName)) return mcpText(result.content).join("\n");
    return result.structuredContent ?? mcpContentValue(result.content);
  }

  const memory = Object.freeze({
    open: (target?: unknown) =>
      config.track(
        (async () => {
          const open = config.bindings().openMemory;
          if (!open) {
            throw new Error("memory is unavailable: no invoking tool scope.");
          }
          if (config.signal().aborted) throw new Error(config.abortedMessage);
          return open(target);
        })(),
      ),
  });

  // `harness.load(agentId, { ref? })`: a typed view of an agent's
  // memory-backed state over the same `memory.open` handle and permissions.
  const harness = Object.freeze({
    load: (agentId?: unknown, options?: unknown) =>
      config.track(
        (async () => {
          const bindings = config.bindings();
          if (!bindings.openMemory) {
            throw new Error("harness is unavailable: no invoking tool scope.");
          }
          const target = agentId;
          if (typeof target !== "string" || !target) {
            throw new Error("harness.load() takes an agent ID.");
          }
          if (
            options !== undefined &&
            (!options || typeof options !== "object" || Array.isArray(options))
          ) {
            throw new Error("harness.load() options must be an object.");
          }
          const ref = (options as { ref?: unknown } | undefined)?.ref;
          if (ref !== undefined && (typeof ref !== "string" || !ref)) {
            throw new Error("ref must be a non-empty string.");
          }
          if (config.signal().aborted) throw new Error(config.abortedMessage);
          const { loadHarnessSnapshot } = await import(
            "@/tools/memory-handle/harness"
          );
          const repo = (await bindings.openMemory({
            agentId: target,
          })) as Parameters<typeof loadHarnessSnapshot>[0];
          return loadHarnessSnapshot(repo, ref);
        })(),
      ),
  });

  return {
    tools,
    memory,
    harness,
    /** `[{ name, description }]` for every tool callable through `tools`. */
    async listTools() {
      return (await loadToolInfo()).map(({ name, description }) => ({
        name,
        description,
      }));
    },
    /** `{ name, description, inputSchema }`, or undefined for an unknown tool. */
    async describeTool(name) {
      if (typeof name !== "string" || !name) {
        throw new Error("describeTool() requires a tool name string.");
      }
      return (await loadToolInfo()).find((tool) => tool.name === name);
    },
    resetToolInfo() {
      toolInfo = undefined;
    },
  };
}

async function collectResults(tasks: Promise<unknown>[]): Promise<unknown[]> {
  // Preserve sibling completion, but never turn an unhandled failure into
  // a successful null result. Scripts can catch inside each callback for
  // best-effort processing.
  const outcomes = await Promise.allSettled(tasks);
  return outcomes.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
}

export async function parallel(thunks: unknown): Promise<unknown[]> {
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

export async function pipeline(
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
  const stageFns = stages.filter((s): s is StageFn => typeof s === "function");
  // No barrier between stages: each item flows through its whole chain
  // independently, so item A can be in stage 3 while item B is in stage 1.
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
