import type {
  CanUseToolCallback,
  CanUseToolContext,
  CanUseToolPermissionSuggestion,
  CanUseToolResponse,
  LettaCodeSession,
  PermissionMode,
  SDKMessage,
  SessionDeviceStatus,
  TranscriptAccumulator,
} from "@letta-ai/letta-agent-sdk/client";
import { createTranscriptAccumulator } from "@letta-ai/letta-agent-sdk/client";
import {
  countCommittedPrefix,
  type LocalRow,
  projectItems,
  type TuiItem,
  userItemId,
} from "./project-rows";

export type TuiSession = Pick<
  LettaCodeSession,
  | "ready"
  | "send"
  | "stream"
  | "abort"
  | "listMessages"
  | "recoverPendingApprovals"
  | "changeDeviceState"
  | "removeQueuedMessage"
  | "getDeviceStatus"
  | "onDeviceStatus"
  | "close"
>;

export type TuiConnection =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export type TuiRunPhase =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "interrupting";

export interface TuiApproval {
  requestId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: string;
  permissionSuggestions: CanUseToolPermissionSuggestion[];
}

export interface TuiQueueItem {
  id: string;
  text: string;
  pendingRemoval?: boolean;
}

export interface TuiDeviceState {
  permissionMode: PermissionMode;
  cwd: string | null;
  memoryDirectory: string | null;
}

export interface TuiSessionInfo {
  agentId: string;
  conversationId: string;
  model: string | null;
}

export interface TuiSnapshot {
  connection: TuiConnection;
  run: TuiRunPhase;
  items: TuiItem[];
  committedCount: number;
  epoch: number;
  approvals: TuiApproval[];
  queue: TuiQueueItem[];
  device: TuiDeviceState | null;
  session: TuiSessionInfo | null;
}

export type TuiApprovalDecision =
  | { kind: "allow" }
  | { kind: "allow_always" }
  | { kind: "deny"; reason?: string };

export interface TuiSessionStore {
  getSnapshot(): TuiSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  resolveApproval(requestId: string, decision: TuiApprovalDecision): void;
  removeQueued(id: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  reconnect(): Promise<void>;
  note(lines: string[]): void;
  close(): void;
}

export interface TuiSessionStoreOptions {
  openSession: (canUseTool: CanUseToolCallback) => TuiSession;
  accumulator?: TranscriptAccumulator;
  historyLimit?: number;
  flushMs?: number;
  createId?: (prefix: string) => string;
}

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_FLUSH_MS = 50;
const DEFAULT_DENY_REASON = "Denied in the terminal";

const EMPTY_SNAPSHOT: TuiSnapshot = {
  connection: "connecting",
  run: "idle",
  items: [],
  committedCount: 0,
  epoch: 0,
  approvals: [],
  queue: [],
  device: null,
  session: null,
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readableError(text: string): string {
  let current: unknown = text;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed.startsWith("{")) return trimmed;
      try {
        current = JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
      continue;
    }
    if (!current || typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    current = record.error ?? record.message ?? record.detail;
  }
  return typeof current === "string" ? current : text;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function runFromLoopStatus(
  status: string,
  current: TuiRunPhase,
  hasApprovals: boolean,
): TuiRunPhase {
  const normalized = status.toUpperCase();
  if (normalized === "WAITING_ON_APPROVAL") return "awaiting_approval";
  if (normalized.startsWith("WAITING") || normalized === "IDLE") return "idle";
  if (current === "interrupting") return current;
  return hasApprovals ? "awaiting_approval" : "running";
}

class SessionStore implements TuiSessionStore {
  private snapshot: TuiSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly accumulator: TranscriptAccumulator;
  private session: TuiSession | null = null;
  private localRows: LocalRow[] = [];
  private committedIds: string[] = [];
  private readonly resolvers = new Map<
    string,
    {
      resolve: (response: CanUseToolResponse) => void;
      suggestions: CanUseToolPermissionSuggestion[];
    }
  >();
  private pendingDeltas: SDKMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopDeviceWatch: (() => void) | null = null;
  private closed = false;
  private counter = 0;

  constructor(private readonly options: TuiSessionStoreOptions) {
    this.accumulator = options.accumulator ?? createTranscriptAccumulator();
  }

  getSnapshot = (): TuiSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async start(): Promise<void> {
    const session = this.options.openSession(this.canUseTool);
    this.session = session;
    try {
      const info = await session.ready();
      if (this.closed) return;
      this.patch({
        session: {
          agentId: info.agentId,
          conversationId: info.conversationId,
          model: info.model ?? null,
        },
      });
      await this.hydrate(session);
      if (this.closed) return;
      this.stopDeviceWatch = session.onDeviceStatus((status) =>
        this.applyDeviceStatus(status),
      );
      this.patch({ connection: "connected" });
      void this.consume(session);
      void this.syncDevice(session);
    } catch (error) {
      if (this.closed) return;
      this.appendLocal({
        kind: "error",
        id: this.id("error"),
        text: errorText(error, "Unable to start the session."),
      });
      this.patch({ connection: "closed", run: "idle" });
    }
  }

  async send(text: string): Promise<void> {
    const session = this.session;
    if (!session || this.closed) return;
    const otid = this.id("tui-input");
    const idle = this.snapshot.run === "idle";
    if (idle) {
      this.appendLocal({
        kind: "user",
        id: otid,
        text,
        otid,
        pending: true,
      });
      this.patch({ run: "running" });
    }
    try {
      await session.send(text, { otid });
      this.updateLocal(otid, (item) =>
        item.kind === "user" ? { ...item, pending: undefined } : item,
      );
    } catch (error) {
      this.updateLocal(otid, (item) =>
        item.kind === "user" ? { ...item, pending: undefined } : item,
      );
      this.appendLocal({
        kind: "error",
        id: this.id("error"),
        text: errorText(error, "Send failed."),
      });
      if (idle) this.patch({ run: "idle" });
    }
  }

  async interrupt(): Promise<void> {
    const session = this.session;
    const previous = this.snapshot.run;
    if (!session || previous === "idle" || previous === "interrupting") return;
    this.denyAllApprovals("Interrupted");
    this.patch({ run: "interrupting" });
    try {
      await session.abort();
    } catch (error) {
      this.appendLocal({
        kind: "error",
        id: this.id("error"),
        text: errorText(error, "Unable to interrupt the run."),
      });
      if (this.snapshot.run === "interrupting") this.patch({ run: previous });
    }
  }

  resolveApproval(requestId: string, decision: TuiApprovalDecision): void {
    const entry = this.resolvers.get(requestId);
    if (!entry) return;
    this.resolvers.delete(requestId);
    const approvals = this.snapshot.approvals.filter(
      (approval) => approval.requestId !== requestId,
    );
    const run =
      this.snapshot.run === "awaiting_approval"
        ? approvals.length > 0
          ? "awaiting_approval"
          : "running"
        : this.snapshot.run;
    this.patch({ approvals, run });
    if (decision.kind === "deny") {
      entry.resolve({
        behavior: "deny",
        message: decision.reason?.trim() || DEFAULT_DENY_REASON,
      });
      return;
    }
    entry.resolve({
      behavior: "allow",
      ...(decision.kind === "allow_always" && entry.suggestions.length > 0
        ? { updatedPermissions: entry.suggestions }
        : {}),
    });
  }

  async removeQueued(id: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.patch({
      queue: this.snapshot.queue.map((item) =>
        item.id === id ? { ...item, pendingRemoval: true } : item,
      ),
    });
    try {
      await session.removeQueuedMessage(id);
    } catch (error) {
      this.patch({
        queue: this.snapshot.queue.map((item) =>
          item.id === id ? { id: item.id, text: item.text } : item,
        ),
      });
      this.appendLocal({
        kind: "error",
        id: this.id("error"),
        text: errorText(error, "Unable to remove the queued message."),
      });
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const session = this.session;
    if (!session) return;
    await session.changeDeviceState({ permissionMode: mode });
    await this.syncDevice(session);
  }

  async reconnect(): Promise<void> {
    const session = this.session;
    if (!session || this.closed) return;
    this.patch({ connection: "reconnecting" });
    try {
      await this.hydrate(session);
      await session.recoverPendingApprovals().catch(() => undefined);
      await this.syncDevice(session);
      if (!this.closed) this.patch({ connection: "connected" });
    } catch (error) {
      if (this.closed) return;
      this.appendLocal({
        kind: "error",
        id: this.id("error"),
        text: errorText(error, "Unable to reconnect."),
      });
      this.patch({ connection: "closed" });
    }
  }

  note(lines: string[]): void {
    this.appendLocal({ kind: "status", id: this.id("status"), lines });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingDeltas = [];
    this.stopDeviceWatch?.();
    this.stopDeviceWatch = null;
    this.denyAllApprovals("Session closed");
    this.session?.close();
    this.patch({ connection: "closed", run: "idle", approvals: [] });
    this.listeners.clear();
  }

  private readonly canUseTool: CanUseToolCallback = (
    toolName,
    toolInput,
    context?: CanUseToolContext,
  ) => {
    if (this.closed) {
      return { behavior: "deny", message: "Session closed" };
    }
    const requestId = context?.requestId ?? this.id("approval");
    const suggestions = context?.permissionSuggestions ?? [];
    const approval: TuiApproval = {
      requestId,
      toolCallId: context?.toolCallId ?? requestId,
      toolName,
      toolArgs: JSON.stringify(toolInput),
      permissionSuggestions: suggestions,
    };
    return new Promise<CanUseToolResponse>((resolve) => {
      this.resolvers.set(requestId, { resolve, suggestions });
      this.patch({
        approvals: [
          ...this.snapshot.approvals.filter(
            (existing) => existing.requestId !== requestId,
          ),
          approval,
        ],
        run:
          this.snapshot.run === "interrupting"
            ? "interrupting"
            : "awaiting_approval",
      });
    });
  };

  private denyAllApprovals(message: string): void {
    for (const [, entry] of this.resolvers) {
      entry.resolve({ behavior: "deny", message });
    }
    this.resolvers.clear();
    if (this.snapshot.approvals.length > 0) this.patch({ approvals: [] });
  }

  private async hydrate(session: TuiSession): Promise<void> {
    const page = await session.listMessages({
      limit: this.options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    });
    if (this.closed) return;
    this.accumulator.rebase({ messages: page.messages }, { order: "desc" });
    this.patch({});
  }

  private async syncDevice(session: TuiSession): Promise<void> {
    try {
      const status = await session.getDeviceStatus();
      if (!this.closed) this.applyDeviceStatus(status);
    } catch {}
  }

  private applyDeviceStatus(status: SessionDeviceStatus): void {
    const pendingIds = new Set(
      status.pendingControlRequests.map((request) => request.requestId),
    );
    const approvals = this.snapshot.approvals.filter(
      (approval) =>
        this.resolvers.has(approval.requestId) ||
        pendingIds.has(approval.requestId),
    );
    const run: TuiRunPhase =
      this.snapshot.run === "interrupting" && status.isProcessing
        ? "interrupting"
        : approvals.length > 0
          ? "awaiting_approval"
          : status.isProcessing
            ? "running"
            : "idle";
    this.patch({
      device: {
        permissionMode: status.permissionMode,
        cwd: status.workingDirectory,
        memoryDirectory: status.memoryDirectory,
      },
      approvals,
      run,
    });
  }

  private async consume(session: TuiSession): Promise<void> {
    try {
      while (!this.closed && this.session === session) {
        let received = false;
        for await (const message of session.stream()) {
          if (this.closed) return;
          received = true;
          this.ingest(message);
        }
        if (!received) throw new Error("Session stream closed.");
      }
    } catch (error) {
      if (this.closed) return;
      this.drainDeltas();
      this.denyAllApprovals("Session stream closed");
      this.appendLocal({
        kind: "error",
        id: this.id("error"),
        text: errorText(error, "Session stream closed."),
      });
      this.patch({ connection: "closed", run: "idle" });
    }
  }

  private ingest(message: SDKMessage): void {
    if (message.type === "stream_event" && !this.isUserEvent(message)) {
      this.pendingDeltas.push(message);
      if (this.flushTimer) return;
      this.drainDeltas();
      this.patch({});
      this.armFlush();
      return;
    }
    this.drainDeltas();
    this.reduce(message);
  }

  private armFlush(): void {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pendingDeltas.length === 0 || this.closed) return;
      this.drainDeltas();
      this.patch({});
      this.armFlush();
    }, this.options.flushMs ?? DEFAULT_FLUSH_MS);
  }

  private drainDeltas(): void {
    const deltas = this.pendingDeltas;
    if (deltas.length === 0) return;
    this.pendingDeltas = [];
    for (const delta of deltas) this.accumulator.apply(delta);
  }

  private isUserEvent(message: SDKMessage): boolean {
    return (
      message.type === "stream_event" &&
      (message.event as { message_type?: string }).message_type ===
        "user_message"
    );
  }

  private reduce(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event":
        this.applyUserEvent(message.event as Record<string, unknown>);
        return;
      case "assistant":
      case "reasoning":
      case "tool_call":
      case "tool_result":
        this.accumulator.apply(message);
        this.patch(
          this.snapshot.run === "idle" && message.type !== "tool_result"
            ? { run: "running" }
            : {},
        );
        return;
      case "queue_update":
        this.patch({
          queue: message.queue
            .filter(
              (item) =>
                !this.localRows.some(
                  (row) => row.item.id === item.clientMessageId,
                ),
            )
            .map((item) => ({
              id: item.id,
              text: contentText(item.content),
            })),
        });
        return;
      case "loop_status":
        this.patch({
          run: runFromLoopStatus(
            message.status,
            this.snapshot.run,
            this.snapshot.approvals.length > 0,
          ),
        });
        return;
      case "result":
        if (!message.success && message.stopReason !== "interrupted") {
          this.appendLocal({
            kind: "error",
            id: this.id("error"),
            text: readableError(
              message.errorDetail ?? message.error ?? "The run failed.",
            ),
          });
        } else if (message.stopReason === "interrupted") {
          this.appendLocal({
            kind: "status",
            id: this.id("status"),
            lines: ["Interrupted"],
          });
        }
        this.patch({ run: "idle" });
        return;
      case "error":
        this.appendLocal({
          kind: "error",
          id: this.id("error"),
          text: readableError(
            message.message || "The server reported an error.",
          ),
        });
        return;
      default:
        return;
    }
  }

  private applyUserEvent(event: Record<string, unknown>): void {
    const otid = typeof event.otid === "string" ? event.otid : undefined;
    const id = otid ?? (typeof event.id === "string" ? event.id : undefined);
    if (!id) return;
    const known =
      this.localRows.some((row) => row.item.id === id) ||
      this.accumulator
        .rows()
        .some((row) => row.kind === "user" && userItemId(row) === id);
    if (known) return;
    const text = contentText(event.content);
    if (!text) return;
    this.appendLocal({ kind: "user", id, text, otid });
  }

  private appendLocal(item: TuiItem): void {
    this.localRows = [
      ...this.localRows,
      { anchor: this.accumulator.rows().length, item },
    ];
    this.patch({});
  }

  private updateLocal(id: string, update: (item: TuiItem) => TuiItem): void {
    this.localRows = this.localRows.map((row) =>
      row.item.id === id ? { ...row, item: update(row.item) } : row,
    );
    this.patch({});
  }

  private patch(changes: Partial<TuiSnapshot>): void {
    const next = { ...this.snapshot, ...changes };
    const rows = this.accumulator.rows();
    const serverUserIds = new Set<string>();
    for (const row of rows) {
      if (row.kind === "user") serverUserIds.add(userItemId(row));
    }
    if (serverUserIds.size > 0) {
      this.localRows = this.localRows.filter(
        (row) => !(row.item.kind === "user" && serverUserIds.has(row.item.id)),
      );
    }
    const active = next.run !== "idle";
    const items = projectItems({
      rows,
      localRows: this.localRows,
      running: active,
      awaitingApprovalToolCallIds: new Set(
        next.approvals.map((approval) => approval.toolCallId),
      ),
    });
    const ids = items.map((item) => item.id);
    const stable = this.committedIds.every((id, index) => ids[index] === id);
    const epoch = stable ? next.epoch : next.epoch + 1;
    const committedCount = Math.max(
      stable ? this.committedIds.length : 0,
      countCommittedPrefix(items),
    );
    this.committedIds = ids.slice(0, committedCount);
    this.snapshot = { ...next, items, committedCount, epoch };
    for (const listener of this.listeners) listener();
  }

  private id(prefix: string): string {
    if (this.options.createId) return this.options.createId(prefix);
    this.counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.counter}`;
  }
}

export function createTuiSessionStore(
  options: TuiSessionStoreOptions,
): TuiSessionStore {
  return new SessionStore(options);
}
