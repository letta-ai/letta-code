import type { LoopStatus, StopReasonType } from "@/types/protocol_v2";

export type ActiveTurnLoopStatus = Exclude<
  LoopStatus,
  "WAITING_ON_INPUT" | "EXECUTING_COMMAND"
>;

export type TurnOrigin = "message" | "approval_recovery";

export type TurnLease = Readonly<{
  id: string;
  signal: AbortSignal;
}>;

type IdleTurnState = {
  kind: "idle";
  loopStatus: "WAITING_ON_INPUT";
};

type CommandTurnState = {
  kind: "command";
  loopStatus: "EXECUTING_COMMAND";
};

type ActiveTurnState = {
  kind: "active";
  origin: TurnOrigin;
  lease: TurnLease;
  abortController: AbortController;
  loopStatus: ActiveTurnLoopStatus;
  workingDirectory: string;
  runId: string | null;
  executingToolCallIds: readonly string[];
};

type CancellingTurnState = {
  kind: "cancelling";
  origin: TurnOrigin;
  lease: TurnLease;
  abortController: AbortController;
  runId: string | null;
  executingToolCallIds: readonly string[];
  loopStatus: "WAITING_ON_INPUT";
};

type TurnState =
  | IdleTurnState
  | CommandTurnState
  | ActiveTurnState
  | CancellingTurnState;

export type TurnLifecycleSnapshot =
  | IdleTurnState
  | CommandTurnState
  | Omit<ActiveTurnState, "abortController">
  | Omit<CancellingTurnState, "abortController">;

export type TurnCancellationTransition = {
  transitioned: boolean;
  lease: TurnLease | null;
  runId: string | null;
  executingToolCallIds: readonly string[];
};

export type TurnFinishTransition = {
  finished: boolean;
  previousKind: "active" | "cancelling" | null;
  runId: string | null;
};

const IDLE_STATE: IdleTurnState = {
  kind: "idle",
  loopStatus: "WAITING_ON_INPUT",
};

export class TurnLifecycle {
  readonly #createId: () => string;
  #state: TurnState = IDLE_STATE;
  #lastStopReason: StopReasonType | null = null;

  constructor(createId: () => string = () => crypto.randomUUID()) {
    this.#createId = createId;
  }

  get kind(): TurnState["kind"] {
    return this.#state.kind;
  }

  get isProcessing(): boolean {
    return this.#state.kind === "active";
  }

  get cancelRequested(): boolean {
    return this.#state.kind === "cancelling";
  }

  get loopStatus(): LoopStatus {
    return this.#state.loopStatus;
  }

  get activeWorkingDirectory(): string | null {
    return this.#state.kind === "active" ? this.#state.workingDirectory : null;
  }

  get activeRunId(): string | null {
    return this.#state.kind === "active" ? this.#state.runId : null;
  }

  get executingToolCallIds(): readonly string[] {
    return this.#state.kind === "active" || this.#state.kind === "cancelling"
      ? this.#state.executingToolCallIds
      : [];
  }

  get lastStopReason(): StopReasonType | null {
    return this.#lastStopReason;
  }

  get currentLease(): TurnLease | null {
    return this.#state.kind === "active" || this.#state.kind === "cancelling"
      ? this.#state.lease
      : null;
  }

  snapshot(): TurnLifecycleSnapshot {
    const state = this.#state;
    if (state.kind === "active") {
      return {
        kind: state.kind,
        origin: state.origin,
        lease: state.lease,
        loopStatus: state.loopStatus,
        workingDirectory: state.workingDirectory,
        runId: state.runId,
        executingToolCallIds: [...state.executingToolCallIds],
      };
    }
    if (state.kind === "cancelling") {
      return {
        kind: state.kind,
        origin: state.origin,
        lease: state.lease,
        runId: state.runId,
        executingToolCallIds: [...state.executingToolCallIds],
        loopStatus: state.loopStatus,
      };
    }
    return { ...state };
  }

  begin(options: {
    origin: TurnOrigin;
    workingDirectory: string;
    initialStatus?: ActiveTurnLoopStatus;
    abortController?: AbortController;
    executingToolCallIds?: readonly string[];
  }): TurnLease {
    if (this.#state.kind === "active" || this.#state.kind === "cancelling") {
      throw new Error(
        `Cannot begin a turn while lifecycle is ${this.#state.kind}`,
      );
    }

    const abortController = options.abortController ?? new AbortController();
    const lease = Object.freeze({
      id: this.#createId(),
      signal: abortController.signal,
    });
    this.#state = {
      kind: "active",
      origin: options.origin,
      lease,
      abortController,
      loopStatus: options.initialStatus ?? "SENDING_API_REQUEST",
      workingDirectory: options.workingDirectory,
      runId: null,
      executingToolCallIds: [...(options.executingToolCallIds ?? [])],
    };
    this.#lastStopReason = null;
    return lease;
  }

  isCurrent(lease: TurnLease): boolean {
    return (
      (this.#state.kind === "active" || this.#state.kind === "cancelling") &&
      this.#state.lease.id === lease.id
    );
  }

  setStatus(lease: TurnLease, status: ActiveTurnLoopStatus): boolean {
    if (this.#state.kind !== "active" || !this.isCurrent(lease)) {
      return false;
    }
    if (this.#state.loopStatus === status) {
      return false;
    }
    this.#state = { ...this.#state, loopStatus: status };
    return true;
  }

  setRunId(lease: TurnLease, runId: string | null): boolean {
    if (this.#state.kind !== "active" || !this.isCurrent(lease)) {
      return false;
    }
    if (this.#state.runId === runId) {
      return false;
    }
    this.#state = { ...this.#state, runId };
    return true;
  }

  setExecutingToolCallIds(
    lease: TurnLease,
    toolCallIds: readonly string[],
  ): boolean {
    if (this.#state.kind !== "active" || !this.isCurrent(lease)) {
      return false;
    }
    this.#state = {
      ...this.#state,
      executingToolCallIds: [...toolCallIds],
    };
    return true;
  }

  recordStopReason(lease: TurnLease, stopReason: StopReasonType): boolean {
    if (this.#state.kind !== "active" || !this.isCurrent(lease)) {
      return false;
    }
    this.#lastStopReason = stopReason;
    return true;
  }

  startCommand(): boolean {
    if (this.#state.kind !== "idle") {
      return false;
    }
    this.#state = {
      kind: "command",
      loopStatus: "EXECUTING_COMMAND",
    };
    return true;
  }

  finishCommand(): boolean {
    if (this.#state.kind !== "command") {
      return false;
    }
    this.#state = IDLE_STATE;
    return true;
  }

  requestCancellation(): TurnCancellationTransition {
    const state = this.#state;
    if (state.kind === "cancelling") {
      return {
        transitioned: false,
        lease: state.lease,
        runId: state.runId,
        executingToolCallIds: [...state.executingToolCallIds],
      };
    }
    if (state.kind !== "active") {
      return {
        transitioned: false,
        lease: null,
        runId: null,
        executingToolCallIds: [],
      };
    }

    if (!state.abortController.signal.aborted) {
      state.abortController.abort();
    }
    this.#lastStopReason = "cancelled";
    this.#state = {
      kind: "cancelling",
      origin: state.origin,
      lease: state.lease,
      abortController: state.abortController,
      runId: state.runId,
      executingToolCallIds: [...state.executingToolCallIds],
      loopStatus: "WAITING_ON_INPUT",
    };
    return {
      transitioned: true,
      lease: state.lease,
      runId: state.runId,
      executingToolCallIds: [...state.executingToolCallIds],
    };
  }

  finish(lease: TurnLease, stopReason: StopReasonType): TurnFinishTransition {
    const state = this.#state;
    if (
      (state.kind !== "active" && state.kind !== "cancelling") ||
      state.lease.id !== lease.id
    ) {
      return { finished: false, previousKind: null, runId: null };
    }

    this.#lastStopReason = stopReason;
    this.#state = IDLE_STATE;
    return {
      finished: true,
      previousKind: state.kind,
      runId: state.runId,
    };
  }

  reset(stopReason: StopReasonType = "cancelled"): TurnFinishTransition {
    const state = this.#state;
    if (state.kind === "active" || state.kind === "cancelling") {
      if (!state.abortController.signal.aborted) {
        state.abortController.abort();
      }
      this.#lastStopReason = stopReason;
      this.#state = IDLE_STATE;
      return {
        finished: true,
        previousKind: state.kind,
        runId: state.runId,
      };
    }

    this.#state = IDLE_STATE;
    return { finished: false, previousKind: null, runId: null };
  }
}
