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
  /** Every run this lease has owned, so a late exact abort still matches. */
  runIds: readonly string[];
  executingToolCallIds: readonly string[];
};

type CancellingTurnState = {
  kind: "cancelling";
  origin: TurnOrigin;
  lease: TurnLease;
  abortController: AbortController;
  runId: string | null;
  runIds: readonly string[];
  executingToolCallIds: readonly string[];
  loopStatus: "WAITING_ON_INPUT";
  ownerFinished: boolean;
  externalSettlementPending: boolean;
};

type TurnState =
  | IdleTurnState
  | CommandTurnState
  | ActiveTurnState
  | CancellingTurnState;

export type TurnLifecycleSnapshot =
  | IdleTurnState
  | CommandTurnState
  | Omit<ActiveTurnState, "abortController" | "runIds">
  | Omit<
      CancellingTurnState,
      | "abortController"
      | "ownerFinished"
      | "externalSettlementPending"
      | "runIds"
    >;

/** How an exact run ID relates to this conversation's turn leases. */
export type TurnRunMatch = "current" | "settled" | null;

const SETTLED_RUN_HISTORY_LIMIT = 32;

export type TurnCancellationTransition = {
  transitioned: boolean;
  lease: TurnLease | null;
  runId: string | null;
  executingToolCallIds: readonly string[];
};

export type TurnCancellationSettlementTransition = {
  settled: boolean;
  released: boolean;
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
  readonly #settledRunIds: string[];

  /**
   * `settledRunIds` may be shared with the listener so settled-run history
   * survives eviction of an idle conversation runtime.
   */
  constructor(
    createId: () => string = () => crypto.randomUUID(),
    settledRunIds: string[] = [],
  ) {
    this.#createId = createId;
    this.#settledRunIds = settledRunIds;
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
    if (this.#state.kind === "active") {
      return this.#state.lease;
    }
    if (this.#state.kind === "cancelling" && !this.#state.ownerFinished) {
      return this.#state.lease;
    }
    return null;
  }

  /**
   * Match an exact run against the unsettled lease, then against recently
   * settled leases. Lets a second abort for the same run join or observe the
   * first one instead of reporting the run as unknown.
   */
  matchRun(runId: string): TurnRunMatch {
    const state = this.#state;
    if (
      (state.kind === "active" || state.kind === "cancelling") &&
      state.runIds.includes(runId)
    ) {
      return "current";
    }
    return this.#settledRunIds.includes(runId) ? "settled" : null;
  }

  /**
   * The unsettled lease's ID while it has not yet observed any run ID. An
   * exact abort that arrives before the first ID-bearing stream chunk cannot
   * tell yet whether this lease owns its run.
   */
  get unboundLeaseId(): string | null {
    const state = this.#state;
    return (state.kind === "active" || state.kind === "cancelling") &&
      state.runIds.length === 0
      ? state.lease.id
      : null;
  }

  #becomeIdle(state: ActiveTurnState | CancellingTurnState): void {
    // The newest settled lease is always attested in full, even when it owned
    // more runs than the history limit; older leases fill whatever room is left.
    const newest = new Set(state.runIds);
    const older = this.#settledRunIds.filter((runId) => !newest.has(runId));
    const room = Math.max(0, SETTLED_RUN_HISTORY_LIMIT - newest.size);
    this.#settledRunIds.splice(
      0,
      this.#settledRunIds.length,
      ...older.slice(older.length - room),
      ...state.runIds,
    );
    this.#state = IDLE_STATE;
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
      runIds: [],
      executingToolCallIds: [...(options.executingToolCallIds ?? [])],
    };
    this.#lastStopReason = null;
    return lease;
  }

  isCurrent(lease: TurnLease): boolean {
    return (
      (this.#state.kind === "active" || this.#state.kind === "cancelling") &&
      (this.#state.kind !== "cancelling" || !this.#state.ownerFinished) &&
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
    const runIds =
      runId && !this.#state.runIds.includes(runId)
        ? [...this.#state.runIds, runId]
        : this.#state.runIds;
    this.#state = { ...this.#state, runId, runIds };
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

  requestCancellation(options?: {
    waitForExternalSettlement?: boolean;
  }): TurnCancellationTransition {
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
      runIds: state.runIds,
      executingToolCallIds: [...state.executingToolCallIds],
      loopStatus: "WAITING_ON_INPUT",
      ownerFinished: false,
      externalSettlementPending: options?.waitForExternalSettlement === true,
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
      state.lease.id !== lease.id ||
      (state.kind === "cancelling" && state.ownerFinished)
    ) {
      return { finished: false, previousKind: null, runId: null };
    }

    this.#lastStopReason = stopReason;
    if (state.kind === "cancelling" && state.externalSettlementPending) {
      this.#state = {
        ...state,
        ownerFinished: true,
      };
    } else {
      this.#becomeIdle(state);
    }
    return {
      finished: true,
      previousKind: state.kind,
      runId: state.runId,
    };
  }

  settleCancellation(lease: TurnLease): TurnCancellationSettlementTransition {
    const state = this.#state;
    if (
      state.kind !== "cancelling" ||
      state.lease.id !== lease.id ||
      !state.externalSettlementPending
    ) {
      return { settled: false, released: false };
    }

    if (state.ownerFinished) {
      this.#becomeIdle(state);
      return { settled: true, released: true };
    }

    this.#state = {
      ...state,
      externalSettlementPending: false,
    };
    return { settled: true, released: false };
  }

  reset(stopReason: StopReasonType = "cancelled"): TurnFinishTransition {
    const state = this.#state;
    if (state.kind === "active" || state.kind === "cancelling") {
      if (!state.abortController.signal.aborted) {
        state.abortController.abort();
      }
      this.#lastStopReason = stopReason;
      this.#becomeIdle(state);
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
