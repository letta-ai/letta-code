import { subagentScopeMatches } from "@/utils/subagent-scope.js";
import { clearSubagentEvents } from "./subagent-events";

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface ProgressText {
  id: string;
  at: string;
  text: string;
}

export const PROGRESS_TEXT_CHARS = 300;
export const MAX_PROGRESS_TEXTS = 20;

export function excerptProgressText(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export interface SubagentState {
  id: string;
  type: string;
  description: string;
  prompt?: string;
  status: "pending" | "running" | "completed" | "error";
  agentId?: string | null;
  agentURL: string | null;
  conversationId?: string | null;
  superRunId?: string;
  toolCalls: ToolCall[];
  progressTexts?: ProgressText[];
  progressTextCount?: number;
  eventSeq?: number;
  maxToolCallsSeen: number;
  totalTokens: number;
  durationMs: number;
  error?: string;
  result?: string;
  published?: boolean;
  model?: string;
  startTime: number;
  updatedAt?: number;
  toolCallId?: string;
  isBackground?: boolean;
  claimsParentRuntime?: boolean;
  silent?: boolean;
  parentAgentId?: string;
  parentConversationId?: string;
  cancelPending?: boolean;
  stopFailed?: boolean;
  stopAttempts?: number;
  stopOutcome?: {
    attempt: number;
    kind: "failed" | "stopped" | "natural";
  };
}

export type SubagentLifecycleStatus = SubagentState["status"];

export interface SubagentLifecycleItem {
  id: string;
  type: string;
  description: string;
  status: SubagentLifecycleStatus;
  agentId: string | null;
  agentUrl: string | null;
  startedAtMs: number;
  elapsedMs: number;
  isBackground: boolean;
  visibleInTranscript: boolean;
}

export interface SubagentLifecycleContext {
  list(): SubagentLifecycleItem[];
}

interface SubagentStore {
  agents: Map<string, SubagentState>;
  expanded: boolean;
  listeners: Set<() => void>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

const store: SubagentStore = {
  agents: new Map(),
  expanded: false,
  listeners: new Set(),
};

const stateObservers = new WeakMap<
  SubagentState,
  (state: SubagentState) => void
>();

export function observeSubagentState(
  id: string,
  observer: (state: SubagentState) => void,
): void {
  const state = store.agents.get(id);
  if (state) stateObservers.set(state, observer);
}

export function captureSubagentStop(id: string): () => void {
  const state = store.agents.get(id);
  const observer = state && stateObservers.get(state);
  return () => {
    if (!state || !observer) return;
    const current = store.agents.get(id) ?? state;
    observer({
      ...current,
      stopOutcome: { attempt: current.stopAttempts ?? 0, kind: "stopped" },
    });
  };
}

function observeStateChange(
  previous: SubagentState,
  next: SubagentState,
  resultIdentity?: Pick<SubagentState, "agentId" | "conversationId">,
): void {
  const observer = stateObservers.get(previous);
  if (!observer) return;
  stateObservers.set(next, observer);
  if (
    resultIdentity ||
    previous.status !== next.status ||
    previous.agentId !== next.agentId ||
    previous.conversationId !== next.conversationId ||
    previous.cancelPending !== next.cancelPending ||
    previous.stopOutcome?.kind !== next.stopOutcome?.kind
  ) {
    observer(
      resultIdentity
        ? {
            ...next,
            agentId: next.agentId || resultIdentity.agentId,
            conversationId:
              resultIdentity.conversationId || next.conversationId,
          }
        : next,
    );
  }
}

let cachedSnapshot: { agents: SubagentState[]; expanded: boolean } = {
  agents: [],
  expanded: false,
};
let cachedLifecycleItems: SubagentLifecycleItem[] = [];

const DEFAULT_COMPLETED_SUBAGENT_RETENTION_MS = 30_000;
let completedSubagentRetentionMs = DEFAULT_COMPLETED_SUBAGENT_RETENTION_MS;
export const DEFAULT_PUBLISHED_RESULT_RETENTION_MS = 30 * 60_000;
let publishedResultRetentionMs = DEFAULT_PUBLISHED_RESULT_RETENTION_MS;
const completedSubagentCleanupTimers = new Map<string, TimerHandle>();

function updateSnapshot(): void {
  const agents = Array.from(store.agents.values());
  const now = Date.now();
  cachedSnapshot = {
    agents,
    expanded: store.expanded,
  };
  cachedLifecycleItems = agents.map((agent) =>
    toSubagentLifecycleItem(agent, now),
  );
}

function notifyListeners(): void {
  updateSnapshot();
  for (const listener of store.listeners) {
    listener();
  }
}

function clearCompletedSubagentCleanup(id: string): void {
  const existing = completedSubagentCleanupTimers.get(id);
  if (!existing) {
    return;
  }

  clearTimeout(existing);
  completedSubagentCleanupTimers.delete(id);
}

function unrefTimer(timer: TimerHandle): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

function isPublished(agent: SubagentState): boolean {
  return agent.published === true || agent.result !== undefined;
}

function scheduleCompletedSubagentCleanup(id: string): void {
  const agent = store.agents.get(id);
  if (!agent || (agent.status !== "completed" && agent.status !== "error")) {
    return;
  }

  clearCompletedSubagentCleanup(id);
  armCompletedSubagentCleanup(id);
}

function armCompletedSubagentCleanup(id: string): void {
  const agent = store.agents.get(id);
  if (!agent) return;
  const timer = setTimeout(
    () => {
      completedSubagentCleanupTimers.delete(id);
      const current = store.agents.get(id);
      if (
        !current ||
        (current.status !== "completed" && current.status !== "error")
      ) {
        return;
      }

      if (current.cancelPending) {
        armCompletedSubagentCleanup(id);
        return;
      }

      store.agents.delete(id);
      clearSubagentEvents(id);
      notifyListeners();
    },
    isPublished(agent)
      ? publishedResultRetentionMs
      : completedSubagentRetentionMs,
  );
  unrefTimer(timer);
  completedSubagentCleanupTimers.set(id, timer);
}

let subagentCounter = 0;

export function generateSubagentId(): string {
  return `subagent-${Date.now()}-${++subagentCounter}`;
}

export function getSubagentByToolCallId(
  toolCallId: string,
): SubagentState | undefined {
  for (const agent of store.agents.values()) {
    if (agent.toolCallId === toolCallId) {
      return agent;
    }
  }
  return undefined;
}

export function registerSubagent(
  id: string,
  type: string,
  description: string,
  toolCallId?: string,
  isBackground?: boolean,
  silent?: boolean,
  parentScope?: {
    agentId?: string | null;
    conversationId?: string | null;
  },
  prompt?: string,
  claimsParentRuntime?: boolean,
): void {
  const displayType = type.charAt(0).toUpperCase() + type.slice(1);

  const agent: SubagentState = {
    id,
    type: displayType,
    description,
    prompt,
    status: "pending",
    agentId: null,
    agentURL: null,
    toolCalls: [],
    maxToolCallsSeen: 0,
    totalTokens: 0,
    durationMs: 0,
    startTime: Date.now(),
    toolCallId,
    isBackground,
    claimsParentRuntime,
    silent,
    parentAgentId: parentScope?.agentId ?? undefined,
    parentConversationId:
      parentScope?.conversationId && parentScope.conversationId.length > 0
        ? parentScope.conversationId
        : undefined,
  };

  clearCompletedSubagentCleanup(id);
  store.agents.set(id, agent);
  notifyListeners();
}

export function updateSubagent(
  id: string,
  updates: Partial<Omit<SubagentState, "id">>,
): void {
  const agent = store.agents.get(id);
  if (!agent) return;

  if (updates.agentURL && agent.status === "pending") {
    updates.status = "running";
  }

  const nextToolCalls = updates.toolCalls ?? agent.toolCalls;
  const nextMax = Math.max(
    agent.maxToolCallsSeen,
    nextToolCalls.length,
    updates.maxToolCallsSeen ?? 0,
  );

  const keys = Object.keys(updates) as (keyof typeof updates)[];
  const isNoop =
    keys.every((k) => agent[k] === updates[k]) &&
    nextMax === agent.maxToolCallsSeen;
  if (isNoop) return;

  const updatedAgent = {
    ...agent,
    ...updates,
    maxToolCallsSeen: nextMax,
    updatedAt: Date.now(),
  };
  store.agents.set(id, updatedAgent);
  observeStateChange(agent, updatedAgent);
  if (updatedAgent.status === "completed" || updatedAgent.status === "error") {
    scheduleCompletedSubagentCleanup(id);
  } else {
    clearCompletedSubagentCleanup(id);
  }
  notifyListeners();
}

export function addToolCall(
  subagentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: string,
): void {
  const agent = store.agents.get(subagentId);
  if (!agent) return;

  if (agent.toolCalls.some((tc) => tc.id === toolCallId)) return;

  const updatedAgent = {
    ...agent,
    toolCalls: [
      ...agent.toolCalls,
      { id: toolCallId, name: toolName, args: toolArgs },
    ],
    maxToolCallsSeen: Math.max(
      agent.maxToolCallsSeen,
      agent.toolCalls.length + 1,
    ),
  };
  store.agents.set(subagentId, updatedAgent);
  observeStateChange(agent, updatedAgent);
  notifyListeners();
}

export function addProgressText(
  subagentId: string,
  text: string,
  now: () => Date = () => new Date(),
): void {
  const agent = store.agents.get(subagentId);
  if (!agent) return;
  const excerpt = excerptProgressText(text, PROGRESS_TEXT_CHARS);
  const previous = agent.progressTexts?.at(-1);
  if (!excerpt || previous?.text === excerpt) return;
  const count = (agent.progressTextCount ?? 0) + 1;
  const updatedAgent = {
    ...agent,
    progressTexts: [
      ...(agent.progressTexts ?? []),
      { id: `text-${count}`, at: now().toISOString(), text: excerpt },
    ].slice(-MAX_PROGRESS_TEXTS),
    progressTextCount: count,
  };
  store.agents.set(subagentId, updatedAgent);
  observeStateChange(agent, updatedAgent);
  notifyListeners();
}

export function completeSubagent(
  id: string,
  result: {
    success: boolean;
    error?: string;
    totalTokens?: number;
    result?: string;
    published?: boolean;
  },
  resultIdentity?: Pick<SubagentState, "agentId" | "conversationId">,
): void {
  const agent = store.agents.get(id);
  if (!agent) return;

  const updatedAgent = {
    ...agent,
    status: result.success ? "completed" : "error",
    updatedAt: Date.now(),
    error: result.error,
    stopFailed: undefined,
    ...(result.result !== undefined ? { result: result.result } : {}),
    ...(result.published ? { published: true } : {}),
    durationMs: Date.now() - agent.startTime,
    totalTokens: result.totalTokens ?? agent.totalTokens,
    maxToolCallsSeen: Math.max(agent.maxToolCallsSeen, agent.toolCalls.length),
  } as SubagentState;
  store.agents.set(id, updatedAgent);
  observeStateChange(agent, updatedAgent, resultIdentity);
  scheduleCompletedSubagentCleanup(id);
  notifyListeners();
}

export function __setCompletedSubagentRetentionMsForTests(ms: number): void {
  completedSubagentRetentionMs = ms;
}

export function __resetCompletedSubagentRetentionMsForTests(): void {
  completedSubagentRetentionMs = DEFAULT_COMPLETED_SUBAGENT_RETENTION_MS;
  publishedResultRetentionMs = DEFAULT_PUBLISHED_RESULT_RETENTION_MS;
}

export function __setPublishedResultRetentionMsForTests(ms: number): void {
  publishedResultRetentionMs = ms;
}

export function getSubagentToolCount(
  agent: Pick<SubagentState, "toolCalls" | "maxToolCallsSeen">,
): number {
  return Math.max(agent.toolCalls.length, agent.maxToolCallsSeen);
}

export function toggleExpanded(): void {
  store.expanded = !store.expanded;
  notifyListeners();
}

export function isExpanded(): boolean {
  return store.expanded;
}

export function getSubagents(): SubagentState[] {
  return Array.from(store.agents.values());
}

export function getActiveBackgroundAgents(): SubagentState[] {
  return Array.from(store.agents.values()).filter(
    (a) =>
      a.silent === true && (a.status === "pending" || a.status === "running"),
  );
}

function toSubagentLifecycleItem(
  agent: SubagentState,
  now: number,
): SubagentLifecycleItem {
  return {
    id: agent.id,
    type: agent.type,
    description: agent.description,
    status: agent.status,
    agentId: agent.agentId ?? null,
    agentUrl: agent.agentURL,
    startedAtMs: agent.startTime,
    elapsedMs:
      agent.status === "pending" || agent.status === "running"
        ? Math.max(0, now - agent.startTime)
        : agent.durationMs,
    isBackground: agent.isBackground === true,
    visibleInTranscript: agent.silent !== true,
  };
}

export function getSubagentLifecycleItems(): SubagentLifecycleItem[] {
  const now = Date.now();
  return Array.from(store.agents.values()).map((agent) =>
    toSubagentLifecycleItem(agent, now),
  );
}

export function getSubagentLifecycleSnapshot(): SubagentLifecycleItem[] {
  return cachedLifecycleItems;
}

export function getSubagentLifecycleContext(): SubagentLifecycleContext {
  return {
    list: getSubagentLifecycleItems,
  };
}

export function subscribeToSubagentLifecycle(listener: () => void): () => void {
  return subscribe(listener);
}

export function getGroupedSubagents(): Map<string, SubagentState[]> {
  const grouped = new Map<string, SubagentState[]>();
  for (const agent of store.agents.values()) {
    const existing = grouped.get(agent.type) || [];
    existing.push(agent);
    grouped.set(agent.type, existing);
  }
  return grouped;
}

export function clearCompletedSubagents(): void {
  let removedAny = false;
  for (const [id, agent] of store.agents.entries()) {
    if (isPublished(agent)) continue;
    if (agent.cancelPending) continue;
    if (agent.status === "completed" || agent.status === "error") {
      clearCompletedSubagentCleanup(id);
      store.agents.delete(id);
      clearSubagentEvents(id);
      removedAny = true;
    }
  }
  if (removedAny) {
    notifyListeners();
  }
}

export function clearSubagentsByIds(ids: string[]): void {
  let removedAny = false;
  for (const id of ids) {
    const agent = store.agents.get(id);
    if (agent?.cancelPending) {
      updateSubagent(id, { silent: true });
      continue;
    }
    clearCompletedSubagentCleanup(id);
    clearSubagentEvents(id);
    removedAny = store.agents.delete(id) || removedAny;
  }
  if (removedAny) {
    notifyListeners();
  }
}

export function clearAllSubagents(): void {
  for (const id of Array.from(completedSubagentCleanupTimers.keys())) {
    clearCompletedSubagentCleanup(id);
  }
  for (const id of store.agents.keys()) clearSubagentEvents(id);
  store.agents.clear();
  notifyListeners();
}

export function hasActiveSubagents(): boolean {
  for (const agent of store.agents.values()) {
    if (agent.status === "pending" || agent.status === "running") {
      return true;
    }
  }
  return false;
}

const subagentAbortHooks = new Map<string, () => void>();

export function registerSubagentAbortHook(id: string, hook: () => void): void {
  subagentAbortHooks.set(id, hook);
}

export function clearSubagentAbortHook(id: string): void {
  subagentAbortHooks.delete(id);
}

export function interruptActiveSubagents(
  errorMessage: string,
  scope?: { agentId?: string; conversationId?: string },
): void {
  let anyInterrupted = false;
  for (const [id, agent] of store.agents.entries()) {
    if (agent.status === "pending" || agent.status === "running") {
      if (scope && !subagentMatchesScope(agent, scope)) continue;
      const hook = subagentAbortHooks.get(id);
      hook?.();
      subagentAbortHooks.delete(id);
      const updatedAgent: SubagentState = {
        ...agent,
        status: "error",
        updatedAt: Date.now(),
        error: errorMessage,
        durationMs: Date.now() - agent.startTime,
        ...(hook
          ? { cancelPending: true, stopAttempts: (agent.stopAttempts ?? 0) + 1 }
          : {}),
        stopFailed: undefined,
      };
      store.agents.set(id, updatedAgent);
      observeStateChange(agent, updatedAgent);
      scheduleCompletedSubagentCleanup(id);
      anyInterrupted = true;
    }
  }
  if (anyInterrupted) {
    notifyListeners();
  }
}

export function interruptStopFailedSubagents(
  errorMessage: string,
  scope?: { agentId?: string; conversationId?: string },
): string[] {
  const interrupted: string[] = [];
  for (const [id, agent] of store.agents.entries()) {
    if (!agent.stopFailed) continue;
    if (agent.status !== "pending" && agent.status !== "running") continue;
    if (scope && !subagentMatchesScope(agent, scope)) continue;
    const hook = subagentAbortHooks.get(id);
    hook?.();
    subagentAbortHooks.delete(id);
    const updatedAgent: SubagentState = {
      ...agent,
      status: "error",
      error: errorMessage,
      durationMs: Date.now() - agent.startTime,
      ...(hook
        ? { cancelPending: true, stopAttempts: (agent.stopAttempts ?? 0) + 1 }
        : {}),
      stopFailed: undefined,
    };
    store.agents.set(id, updatedAgent);
    observeStateChange(agent, updatedAgent);
    scheduleCompletedSubagentCleanup(id);
    interrupted.push(id);
  }
  if (interrupted.length > 0) {
    notifyListeners();
  }
  return interrupted;
}

function subagentMatchesScope(
  agent: SubagentState,
  scope: { agentId?: string; conversationId?: string },
): boolean {
  return subagentScopeMatches(
    agent.parentAgentId,
    agent.parentConversationId,
    scope,
  );
}

export function hasStopFailedSubagents(scope?: {
  agentId?: string;
  conversationId?: string;
}): boolean {
  for (const agent of store.agents.values()) {
    if (!agent.stopFailed) continue;
    if (agent.status !== "pending" && agent.status !== "running") continue;
    if (scope && !subagentMatchesScope(agent, scope)) continue;
    return true;
  }
  return false;
}

export function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function getSnapshot(): {
  agents: SubagentState[];
  expanded: boolean;
} {
  return cachedSnapshot;
}

export type SubagentStreamEvent =
  | { type: "message"; message_type: string; [key: string]: unknown }
  | { type: "memory_updated"; affected_paths: string[]; timestamp: number };

export type SubagentStreamEventListener = (
  subagentId: string,
  event: SubagentStreamEvent,
) => void;

const streamEventListeners = new Set<SubagentStreamEventListener>();

export function subscribeToStreamEvents(
  listener: SubagentStreamEventListener,
): () => void {
  streamEventListeners.add(listener);
  return () => {
    streamEventListeners.delete(listener);
  };
}

export function emitStreamEvent(
  subagentId: string,
  event: SubagentStreamEvent,
): void {
  for (const listener of streamEventListeners) {
    listener(subagentId, event);
  }
}
