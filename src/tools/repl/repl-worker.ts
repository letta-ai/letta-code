/**
 * A steerable Repl worker: one subagent conversation driven turn by turn
 * through the workflow spawner. Steering is interrupt-and-continue: the
 * active turn is interrupted and the conversation is resumed with the new
 * message, so the worker keeps its full history.
 */

import type {
  AgentCallOptions,
  SubagentOutcome,
  SubagentSpawner,
} from "@/tools/workflow/types";

export type ReplWorkerStatus =
  | "running"
  | "idle"
  | "failed"
  | "paused"
  | "stopped";

export type ReplTurnStatus = "running" | "done" | "failed" | "interrupted";

export interface ReplTurnRecord {
  index: number;
  prompt: string;
  status: ReplTurnStatus;
  value?: unknown;
  error?: string;
  durationMs?: number;
  totalTokens?: number;
}

export interface ReplWorkerInfo {
  id: string;
  label: string;
  conversationId: string | null;
  status: ReplWorkerStatus;
  turns: number;
  queued: number;
  lastResult?: unknown;
  lastError?: string;
}

/** Per-message overrides; creation-time settings cannot change on continuation. */
export interface ReplSendOptions {
  /** Interrupt the active turn (default) or queue behind it. */
  interrupt?: boolean;
  json?: boolean;
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  maxToolCalls?: number;
}

export interface ReplWorkerDeps {
  id: string;
  getSpawner: () => Promise<SubagentSpawner>;
  nextCallIndex: () => number;
  /** Called when the worker settles with nothing left to run. */
  onSettled?: (worker: ReplWorker, turn: ReplTurnRecord) => void;
  /** Delay between continuation retries while an interrupted run finishes. */
  retryDelayMs?: number;
  retryWindowMs?: number;
}

interface QueuedMessage {
  message: string;
  options: ReplSendOptions;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const CONTINUE_MESSAGE =
  "You were paused. Continue the task from where you left off.";
const RUN_NOT_TERMINAL = "Cannot confirm worker's latest run is terminal";
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_RETRY_WINDOW_MS = 30_000;

function guarded<T>(promise: Promise<T>): Promise<T> {
  // Callers may never await a send(); that must not become an unhandled
  // rejection. Awaiting it still observes the original error.
  void promise.catch(() => {});
  return promise;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ReplWorker {
  readonly id: string;
  readonly label: string;
  conversationId: string | null;
  status: ReplWorkerStatus = "idle";
  readonly turns: ReplTurnRecord[] = [];

  private readonly deps: ReplWorkerDeps;
  private readonly startOptions: AgentCallOptions;
  /** Prompt the conversation must open with if no turn has created it yet. */
  private openingPrompt: string | null;
  private active: { controller: AbortController; done: Promise<void> } | null =
    null;
  private queue: QueuedMessage[] = [];
  private waiters: Waiter[] = [];

  constructor(deps: ReplWorkerDeps, prompt: string, options: AgentCallOptions) {
    this.deps = deps;
    this.id = deps.id;
    this.label = options.label ?? deps.id;
    this.startOptions = { ...options, label: this.label };
    this.conversationId = options.conversationId ?? null;
    this.openingPrompt = this.conversationId ? null : prompt;
    void this.enqueue(prompt, {});
  }

  /** Steer: interrupt the active turn (default) and continue with `message`. */
  send(message: unknown, options: ReplSendOptions = {}): Promise<unknown> {
    if (typeof message !== "string" || !message.trim()) {
      return guarded(
        Promise.reject(new Error("send() requires a non-empty message.")),
      );
    }
    if (this.status === "stopped") {
      return guarded(
        Promise.reject(new Error(`Worker ${this.id} is stopped.`)),
      );
    }
    // Capture before enqueueing: an idle worker starts the new turn at once,
    // and that turn must not be interrupted.
    const running = this.active;
    const turn = this.enqueue(message, options);
    if (running && options.interrupt !== false) {
      running.controller.abort();
    }
    return turn;
  }

  /** Interrupt the active turn and hold queued messages until resume(). */
  async pause(): Promise<ReplWorkerInfo> {
    if (this.status !== "stopped") {
      this.status = "paused";
      await this.interruptActive();
    }
    return this.info();
  }

  /** Continue after pause(), optionally with a new message. */
  resume(message?: unknown, options: ReplSendOptions = {}): Promise<unknown> {
    if (this.status === "stopped") {
      return guarded(
        Promise.reject(new Error(`Worker ${this.id} is stopped.`)),
      );
    }
    if (message !== undefined) {
      if (typeof message !== "string" || !message.trim()) {
        return guarded(
          Promise.reject(new Error("resume() message must be non-empty.")),
        );
      }
    }
    const wasPaused = this.status === "paused";
    if (wasPaused) this.status = this.lastTurnStatus();
    const last = this.turns.at(-1);
    let turn: Promise<unknown>;
    if (typeof message === "string") {
      turn = this.enqueue(message, options);
    } else if (this.queue.length === 0 && last?.status === "interrupted") {
      // Interrupted before the conversation existed: open it again instead.
      turn = this.enqueue(this.openingPrompt ?? CONTINUE_MESSAGE, options);
    } else {
      turn = this.result();
    }
    this.pump();
    return turn;
  }

  /** Interrupt the active turn and drop queued messages; the worker goes idle. */
  async interrupt(): Promise<ReplWorkerInfo> {
    if (this.status === "stopped") return this.info();
    this.rejectQueue(`Worker ${this.id} was interrupted.`);
    await this.interruptActive();
    if (this.status === "paused") this.status = this.lastTurnStatus();
    this.notifyWaiters();
    return this.info();
  }

  /** Interrupt and permanently close the worker. */
  async stop(): Promise<ReplWorkerInfo> {
    if (this.status === "stopped") return this.info();
    this.status = "stopped";
    this.rejectQueue(`Worker ${this.id} is stopped.`);
    await this.interruptActive();
    this.notifyWaiters();
    return this.info();
  }

  /**
   * The value of the latest turn once the worker has nothing running or
   * queued. A paused worker is not done; this waits until it is resumed.
   */
  result(): Promise<unknown> {
    const settled = this.settledValue();
    if (settled) return guarded(settled);
    return guarded(
      new Promise((resolve, reject) => this.waiters.push({ resolve, reject })),
    );
  }

  info(): ReplWorkerInfo {
    const last = [...this.turns]
      .reverse()
      .find((turn) => turn.status !== "running");
    return {
      id: this.id,
      label: this.label,
      conversationId: this.conversationId,
      status: this.status,
      turns: this.turns.length,
      queued: this.queue.length,
      ...(last?.status === "done" ? { lastResult: last.value } : {}),
      ...(last?.error ? { lastError: last.error } : {}),
    };
  }

  toJSON(): ReplWorkerInfo {
    return this.info();
  }

  private enqueue(message: string, options: ReplSendOptions): Promise<unknown> {
    const turn = new Promise<unknown>((resolve, reject) => {
      this.queue.push({ message, options, resolve, reject });
    });
    this.pump();
    return guarded(turn);
  }

  private pump(): void {
    if (this.active || this.status === "paused" || this.status === "stopped") {
      return;
    }
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    const controller = new AbortController();
    this.status = "running";
    const done = this.runTurn(batch, controller).finally(() => {
      this.active = null;
      if (this.status === "running") this.status = this.lastTurnStatus();
      this.pump();
      if (!this.active) this.notifyWaiters();
    });
    this.active = { controller, done };
  }

  private async runTurn(
    batch: QueuedMessage[],
    controller: AbortController,
  ): Promise<void> {
    const message = batch.map((entry) => entry.message).join("\n\n");
    const prompt =
      this.conversationId === null && this.openingPrompt !== null
        ? this.openingPrompt === message
          ? message
          : `${this.openingPrompt}\n\n${message}`
        : message;
    const overrides = Object.assign({}, ...batch.map((e) => e.options));
    const record: ReplTurnRecord = {
      index: this.turns.length,
      prompt,
      status: "running",
    };
    this.turns.push(record);
    const outcome = await this.spawnTurn(prompt, overrides, controller.signal);
    if (outcome.conversationId) {
      this.conversationId = outcome.conversationId;
      this.openingPrompt = null;
    }
    record.durationMs = outcome.durationMs;
    record.totalTokens = outcome.totalTokens;
    if (!outcome.failed) {
      record.status = "done";
      record.value = outcome.value;
      for (const entry of batch) entry.resolve(outcome.value);
    } else {
      record.status = controller.signal.aborted ? "interrupted" : "failed";
      record.error = outcome.error ?? "worker turn failed";
      const error = Object.assign(
        new Error(`Worker ${this.id} turn ${record.status}: ${record.error}`),
        { conversationId: this.conversationId },
      );
      for (const entry of batch) entry.reject(error);
    }
    const settledNow = this.queue.length === 0 && this.status === "running";
    if (settledNow && record.status !== "interrupted") {
      this.deps.onSettled?.(this, record);
    }
  }

  private async spawnTurn(
    prompt: string,
    overrides: ReplSendOptions,
    signal: AbortSignal,
  ): Promise<SubagentOutcome> {
    const deadline =
      Date.now() + (this.deps.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS);
    for (;;) {
      try {
        const spawner = await this.deps.getSpawner();
        if (signal.aborted) {
          return {
            value: null,
            failed: true,
            error: "Workflow subagent interrupted",
            ...(this.conversationId
              ? { conversationId: this.conversationId }
              : {}),
          };
        }
        return await spawner(
          {
            prompt,
            options: this.turnOptions(overrides),
            callIndex: this.deps.nextCallIndex(),
          },
          signal,
          {
            onStarted: (conversationId) => {
              this.conversationId = conversationId;
              this.openingPrompt = null;
            },
          },
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        // A run we just interrupted can take a moment to become terminal.
        if (
          text.includes(RUN_NOT_TERMINAL) &&
          !signal.aborted &&
          Date.now() < deadline
        ) {
          await sleep(this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
          continue;
        }
        return {
          value: null,
          failed: true,
          error: text,
          ...(this.conversationId
            ? { conversationId: this.conversationId }
            : {}),
        };
      }
    }
  }

  private turnOptions(overrides: ReplSendOptions): AgentCallOptions {
    const { interrupt: _interrupt, ...perTurn } = overrides;
    if (this.conversationId === null) {
      return { ...this.startOptions, ...perTurn };
    }
    // Model, system prompt, effort, and skills are fixed at creation.
    const {
      model: _model,
      systemPrompt: _systemPrompt,
      effort: _effort,
      skills: _skills,
      ...continuation
    } = this.startOptions;
    return {
      ...continuation,
      ...perTurn,
      conversationId: this.conversationId,
    };
  }

  private async interruptActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.done;
  }

  private lastTurnStatus(): ReplWorkerStatus {
    return this.turns.at(-1)?.status === "failed" ? "failed" : "idle";
  }

  private rejectQueue(reason: string): void {
    for (const entry of this.queue.splice(0)) entry.reject(new Error(reason));
  }

  private settledValue(): Promise<unknown> | null {
    if (this.status === "stopped") {
      return Promise.reject(new Error(`Worker ${this.id} is stopped.`));
    }
    if (this.active || this.queue.length > 0 || this.status === "paused") {
      return null;
    }
    const last = this.turns.at(-1);
    if (!last) return null;
    if (last.status === "done") return Promise.resolve(last.value);
    return Promise.reject(
      Object.assign(
        new Error(`Worker ${this.id} turn ${last.status}: ${last.error}`),
        { conversationId: this.conversationId },
      ),
    );
  }

  private notifyWaiters(): void {
    const settled = this.settledValue();
    if (!settled) return;
    for (const waiter of this.waiters.splice(0)) {
      settled.then(waiter.resolve, waiter.reject);
    }
    void settled.catch(() => {});
  }
}
