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

export interface ReplSendOptions {
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
  onSettled?: (worker: ReplWorker, turn: ReplTurnRecord) => void;
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
    const running = this.active;
    const turn = this.enqueue(message, options);
    if (running && options.interrupt !== false) {
      running.controller.abort();
    }
    return turn;
  }

  async pause(): Promise<ReplWorkerInfo> {
    if (this.status !== "stopped") {
      this.status = "paused";
      await this.interruptActive();
    }
    return this.info();
  }

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
      turn = this.enqueue(this.openingPrompt ?? CONTINUE_MESSAGE, options);
    } else {
      turn = this.result();
    }
    this.pump();
    return turn;
  }

  async interrupt(): Promise<ReplWorkerInfo> {
    if (this.status === "stopped") return this.info();
    this.rejectQueue(`Worker ${this.id} was interrupted.`);
    await this.interruptActive();
    if (this.status === "paused") this.status = this.lastTurnStatus();
    this.notifyWaiters();
    return this.info();
  }

  async stop(): Promise<ReplWorkerInfo> {
    if (this.status === "stopped") return this.info();
    this.status = "stopped";
    this.rejectQueue(`Worker ${this.id} is stopped.`);
    await this.interruptActive();
    this.notifyWaiters();
    return this.info();
  }

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
