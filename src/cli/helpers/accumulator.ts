import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { INTERRUPTED_BY_USER } from "@/constants";
import {
  runPostToolUseHooks,
  runPreCompactHooks,
  runPreToolUseHooks,
} from "@/hooks";
import { clampRawToolReturn } from "@/tools/impl/tool-return-clamp";
import { debugLog } from "@/utils/debug";
import { isRecord } from "@/utils/type-guards";
import { extractCompactionSummary } from "./compaction-utils";
import type { ContextTracker } from "./context-tracker";
import { MAX_CONTEXT_HISTORY } from "./context-tracker";
import { findLastSafeSplitPoint } from "./markdown-split";
import { trimFinishedReasoningText } from "./reasoning-text";
import { isShellOutputTool } from "./tool-name-mapping";
import { extractUnifiedExecRunningSessionId } from "./unified-exec-output";

type CompactionSummaryMessageChunk = {
  message_type: "summary_message";
  id?: string;
  otid?: string;
  summary?: string;
  compaction_stats?: {
    trigger?: string;
    context_tokens_before?: number;
    context_tokens_after?: number;
    context_window?: number;
    messages_count_before?: number;
    messages_count_after?: number;
  };
};

type CompactionEventMessageChunk = {
  message_type: "event_message";
  id?: string;
  otid?: string;
  event_type?: string;
  event_data?: Record<string, unknown>;
};

type StreamingChunk =
  | LettaStreamingResponse
  | CompactionSummaryMessageChunk
  | CompactionEventMessageChunk;

const MAX_TAIL_LINES = 5;
const MAX_BUFFER_SIZE = 100_000;

export interface StreamingLine {
  text: string;
  isStderr: boolean;
}

export interface StreamingState {
  tailLines: StreamingLine[];
  partialLine: string;
  partialIsStderr: boolean;
  totalLineCount: number;
  startTime: number;
}

export function appendStreamingOutput(
  state: StreamingState | undefined,
  chunk: string,
  startTime: number,
  isStderr = false,
): StreamingState {
  const current = state || {
    tailLines: [],
    partialLine: "",
    partialIsStderr: false,
    totalLineCount: 0,
    startTime,
  };

  const tailLines = [...current.tailLines];
  let totalLineCount = current.totalLineCount;
  let partialLine = current.partialLine;
  const partialIsStderr = current.partialIsStderr;

  if (partialLine && isStderr !== partialIsStderr) {
    tailLines.push({ text: partialLine, isStderr: partialIsStderr });
    totalLineCount++;
    partialLine = "";
  }

  let buffer = partialLine + chunk;

  if (buffer.length > MAX_BUFFER_SIZE) {
    const truncated = buffer.slice(-MAX_BUFFER_SIZE);
    const firstNewline = truncated.indexOf("\n");
    buffer = firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated;
  }

  const lines = buffer.split("\n");
  const newPartialLine = lines.pop() || "";

  const newLines: StreamingLine[] = lines.map((text) => ({
    text,
    isStderr,
  }));

  const allLines = [...tailLines, ...newLines];
  const finalTailLines = allLines.slice(-MAX_TAIL_LINES);

  return {
    tailLines: finalTailLines,
    partialLine: newPartialLine,
    partialIsStderr: isStderr,
    totalLineCount: totalLineCount + lines.length,
    startTime: current.startTime,
  };
}

export type Line =
  | {
      kind: "user";
      id: string;
      text: string;
      messageId?: string;
      otid?: string;
    }
  | {
      kind: "reasoning";
      id: string;
      text: string;
      phase: "streaming" | "finished";
      isContinuation?: boolean;
      messageId?: string;
      startedAtMs?: number;
      durationMs?: number;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      phase: "streaming" | "finished";
      isContinuation?: boolean;
      messageId?: string;
    }
  | {
      kind: "tool_call";
      id: string;
      toolCallId?: string;
      name?: string;
      argsText?: string;
      unifiedExecCommandDisplay?: string;
      resultText?: string;
      resultOk?: boolean;
      phase: "streaming" | "ready" | "running" | "finished";
      streaming?: StreamingState;
    }
  | { kind: "error"; id: string; text: string }
  | {
      kind: "event";
      id: string;
      eventType: string;
      eventData: Record<string, unknown>;
      phase: "running" | "finished";
      summary?: string;
      stats?: {
        trigger?: string;
        contextTokensBefore?: number;
        contextTokensAfter?: number;
        contextWindow?: number;
        messagesCountBefore?: number;
        messagesCountAfter?: number;
      };
    }
  | {
      kind: "command";
      id: string;
      input: string;
      output: string;
      phase?: "running" | "waiting" | "finished";
      success?: boolean;
      dimOutput?: boolean;
      preformatted?: boolean;
    }
  | {
      kind: "bash_command";
      id: string;
      input: string;
      output: string;
      phase?: "running" | "finished";
      success?: boolean;
      streaming?: StreamingState;
    }
  | {
      kind: "status";
      id: string;
      lines: string[];
    }
  | {
      kind: "trajectory_summary";
      id: string;
      durationMs: number;
      stepCount: number;
      verb: string;
    }
  | { kind: "separator"; id: string };

export interface ServerToolCallInfo {
  toolName: string;
  toolArgs: string;
  preToolUseTriggered: boolean;
}

export type Buffers = {
  tokenCount: number;
  order: string[];
  byId: Map<string, Line>;
  pendingToolByRun: Map<string, string>;
  toolCallIdToLineId: Map<string, string>;
  userLineIdByOtid: Map<string, string>;
  lastOtid: string | null;
  assistantCanonicalByMessageId: Map<string, string>;
  assistantCanonicalByOtid: Map<string, string>;
  reasoningCanonicalByMessageId: Map<string, string>;
  reasoningCanonicalByOtid: Map<string, string>;
  pendingRefresh?: boolean;
  interrupted?: boolean;
  commitGeneration?: number;
  abortGeneration?: number;
  lastReasoning?: string;
  lastAssistantMessage?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    contextTokens?: number;
    stepCount: number;
  };
  tokenStreamingEnabled?: boolean;
  splitCounters: Map<string, number>;
  serverToolCalls: Map<string, ServerToolCallInfo>;
  unifiedExecSessionCommands: Map<string, string>;
  approvalsPending: boolean;
  agentId?: string;
};

export function createBuffers(agentId?: string): Buffers {
  return {
    tokenCount: 0,
    order: [],
    byId: new Map(),
    pendingToolByRun: new Map(),
    toolCallIdToLineId: new Map(),
    userLineIdByOtid: new Map(),
    lastOtid: null,
    assistantCanonicalByMessageId: new Map(),
    assistantCanonicalByOtid: new Map(),
    reasoningCanonicalByMessageId: new Map(),
    reasoningCanonicalByOtid: new Map(),
    commitGeneration: 0,
    abortGeneration: 0,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      stepCount: 0,
    },
    tokenStreamingEnabled: false,
    splitCounters: new Map(),
    serverToolCalls: new Map(),
    unifiedExecSessionCommands: new Map(),
    approvalsPending: false,
    agentId,
  };
}

function parseToolArgsText(
  argsText: string | undefined,
): Record<string, unknown> | null {
  if (!argsText?.trim()) return null;
  try {
    const parsed = JSON.parse(argsText);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractExecCommandDisplay(
  argsText: string | undefined,
): string | null {
  const parsed = parseToolArgsText(argsText);
  const description = parsed?.description;
  if (typeof description === "string" && description.trim()) {
    return description.trim();
  }
  const cmd = parsed?.cmd;
  return typeof cmd === "string" && cmd.trim() ? cmd : null;
}

function extractWriteStdinSessionId(
  argsText: string | undefined,
): string | null {
  const parsed = parseToolArgsText(argsText);
  const sessionId = parsed?.session_id;
  if (typeof sessionId === "string" && sessionId.trim()) return sessionId;
  if (typeof sessionId === "number" && Number.isFinite(sessionId)) {
    return String(sessionId);
  }
  return null;
}

function annotateWriteStdinCommandDisplay(
  b: Buffers,
  line: ToolCallLine,
): ToolCallLine {
  if (line.name !== "write_stdin") return line;
  const sessionId = extractWriteStdinSessionId(line.argsText);
  if (!sessionId) return line;
  const commandDisplay = b.unifiedExecSessionCommands.get(sessionId);
  if (!commandDisplay || line.unifiedExecCommandDisplay === commandDisplay) {
    return line;
  }
  const updatedLine = { ...line, unifiedExecCommandDisplay: commandDisplay };
  b.byId.set(line.id, updatedLine);
  return updatedLine;
}

function ensure<T extends Line>(b: Buffers, id: string, make: () => T): T {
  const existing = b.byId.get(id) as T | undefined;
  if (existing) return existing;
  const created = make();
  b.byId.set(id, created);
  b.order.push(id);
  return created;
}

function numericEventDataValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringEventDataValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function formatRetryDelay(delayMs: number): string {
  if (delayMs < 1000) return `${Math.max(0, Math.round(delayMs))}ms`;
  return `${Math.round(delayMs / 1000)}s`;
}

function formatRetryEventStatusLines(
  eventData: Record<string, unknown>,
): string[] {
  const attempt = numericEventDataValue(eventData.attempt);
  const maxAttempts = numericEventDataValue(eventData.max_attempts);
  const delayMs = numericEventDataValue(eventData.delay_ms);
  const message = stringEventDataValue(eventData.message);

  const metadata: string[] = [];
  if (attempt !== undefined) {
    metadata.push(
      maxAttempts !== undefined
        ? `attempt ${attempt}/${maxAttempts}`
        : `attempt ${attempt}`,
    );
  }
  if (delayMs !== undefined) {
    metadata.push(`in ${formatRetryDelay(delayMs)}`);
  }

  return [
    `Provider stream error, retrying${
      metadata.length > 0 ? ` (${metadata.join(", ")})` : ""
    }${message ? `: ${message}` : ""}`,
  ];
}

export function upsertStatusLine(
  b: Buffers,
  id: string,
  lines: string[],
): void {
  const existing = b.byId.get(id);
  if (existing?.kind === "status") {
    existing.lines = lines;
    return;
  }
  b.byId.set(id, { kind: "status", id, lines });
  if (!existing) b.order.push(id);
}

function markAsFinished(b: Buffers, id: string) {
  const line = b.byId.get(id);
  if (line && "phase" in line && line.phase === "streaming") {
    const updatedLine =
      line.kind === "reasoning"
        ? {
            ...line,
            text: trimFinishedReasoningText(line.text),
            phase: "finished" as const,
            durationMs:
              line.durationMs ??
              (line.startedAtMs === undefined
                ? undefined
                : Math.max(0, Date.now() - line.startedAtMs)),
          }
        : { ...line, phase: "finished" as const };
    b.byId.set(id, updatedLine);

    if (
      updatedLine.kind === "reasoning" &&
      "text" in updatedLine &&
      updatedLine.text
    ) {
      b.lastReasoning = updatedLine.text;
    }
    if (
      updatedLine.kind === "assistant" &&
      "text" in updatedLine &&
      updatedLine.text
    ) {
      b.lastAssistantMessage = updatedLine.text;
    }
  }
}

function handleOtidTransition(b: Buffers, newOtid: string | undefined) {
  if (b.lastOtid && b.lastOtid !== newOtid) {
    const prev = b.byId.get(b.lastOtid);
    if (prev && (prev.kind === "assistant" || prev.kind === "reasoning")) {
      markAsFinished(b, b.lastOtid);
    }
  }

  b.lastOtid = newOtid ?? null;
}

export function markCurrentLineAsFinished(b: Buffers) {
  if (!b.lastOtid) {
    return;
  }
  const prev = b.byId.get(b.lastOtid);
  if (prev && (prev.kind === "assistant" || prev.kind === "reasoning")) {
    markAsFinished(b, b.lastOtid);
  } else {
  }
}

export type CancelReason =
  | "user_interrupt"
  | "stream_error"
  | "internal_cancel"
  | "approval_cancel";

const CANCEL_REASON_TEXT: Record<CancelReason, string> = {
  user_interrupt: INTERRUPTED_BY_USER,
  stream_error: "Stream error",
  internal_cancel: "Cancelled",
  approval_cancel: "Approval cancelled",
};

export function markIncompleteToolsAsCancelled(
  b: Buffers,
  setInterruptedFlag = true,
  reason: CancelReason = "internal_cancel",
  skipMarkCurrentLine = false,
): boolean {
  if (setInterruptedFlag) {
    b.interrupted = true;
  }

  let anyToolsCancelled = false;
  for (const [id, line] of b.byId.entries()) {
    if (line.kind === "tool_call" && line.phase !== "finished") {
      debugLog(
        "accumulator",
        `[ORPHANED_TOOL] name=${line.name ?? "?"} phase=${line.phase} diagnosis=${diagnoseOrphanedTool(line, b)} reason=${reason}`,
      );
      const updatedLine = {
        ...line,
        phase: "finished" as const,
        resultOk: false,
        resultText: CANCEL_REASON_TEXT[reason],
      };
      b.byId.set(id, updatedLine);
      anyToolsCancelled = true;
    }
  }
  if (!skipMarkCurrentLine) {
    markCurrentLineAsFinished(b);
  }
  return anyToolsCancelled;
}

export function removeIncompleteTools(
  b: Buffers,
  reason = "end_turn",
): boolean {
  let anyToolsRemoved = false;
  for (const [id, line] of b.byId.entries()) {
    if (line.kind === "tool_call" && line.phase !== "finished") {
      debugLog(
        "accumulator",
        `[REMOVED_ORPHANED_TOOL] name=${line.name ?? "?"} phase=${line.phase} diagnosis=${diagnoseOrphanedTool(line, b)} reason=${reason} toolCallId=${line.toolCallId ?? "?"}`,
      );
      b.byId.delete(id);
      b.order = b.order.filter((oid) => oid !== id);
      if (line.toolCallId) {
        b.toolCallIdToLineId.delete(line.toolCallId);
        b.serverToolCalls.delete(line.toolCallId);
      }
      anyToolsRemoved = true;
    }
  }
  return anyToolsRemoved;
}

function diagnoseOrphanedTool(
  line: Extract<Line, { kind: "tool_call" }>,
  b: Buffers,
): string {
  const isTrackedAsServerTool = line.toolCallId
    ? b.serverToolCalls.has(line.toolCallId)
    : false;
  if (line.phase === "streaming") {
    return isTrackedAsServerTool
      ? "server_tool_missing_return"
      : "client_tool_missing_approval_request";
  }
  if (line.phase === "ready") return "approval_pending_at_stream_end";
  if (line.phase === "running") return "execution_incomplete_at_stream_end";
  return "unknown_phase";
}

type ToolCallLine = Extract<Line, { kind: "tool_call" }>;

function getStringProp(obj: Record<string, unknown>, key: string) {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

export function extractTextPart(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (isRecord(p) ? (getStringProp(p, "text") ?? "") : ""))
      .join("");
  }
  if (isRecord(v)) {
    return getStringProp(v, "text") ?? getStringProp(v, "delta") ?? "";
  }
  return "";
}

function markCompactionCompleted(ctx?: ContextTracker): void {
  if (!ctx) return;
  ctx.pendingCompaction = true;
  ctx.pendingReflectionTrigger = true;
  ctx.pendingConversationDescriptionRegeneration = true;
}

function resolveLineIdForKind(
  b: Buffers,
  canonicalId: string,
  kind: "assistant" | "reasoning",
): string {
  const existing = b.byId.get(canonicalId);
  if (!existing || existing.kind === kind) return canonicalId;

  return `${kind}:${canonicalId}`;
}

function hasExistingOtidAlias(
  aliasMap: Map<string, string>,
  canonical: string,
  nextOtid?: string,
): boolean {
  for (const [mappedOtid, mappedCanonical] of aliasMap.entries()) {
    if (mappedCanonical === canonical && mappedOtid !== nextOtid) {
      return true;
    }
  }
  return false;
}

function resolveAssistantLineId(
  b: Buffers,
  chunk: LettaStreamingResponse & { id?: string; otid?: string },
): string | undefined {
  const messageId = typeof chunk.id === "string" ? chunk.id : undefined;
  const otid = typeof chunk.otid === "string" ? chunk.otid : undefined;

  const canonicalFromMessageId = messageId
    ? b.assistantCanonicalByMessageId.get(messageId)
    : undefined;
  const canonicalFromOtid = otid
    ? b.assistantCanonicalByOtid.get(otid)
    : undefined;

  let canonical =
    canonicalFromMessageId || canonicalFromOtid || messageId || otid;
  if (!canonical) return undefined;

  if (otid && !canonicalFromOtid && canonicalFromMessageId) {
    const existingLineId = resolveLineIdForKind(
      b,
      canonicalFromMessageId,
      "assistant",
    );
    const existingLine = b.byId.get(existingLineId);
    const hasPriorOtidAlias = hasExistingOtidAlias(
      b.assistantCanonicalByOtid,
      canonicalFromMessageId,
      otid,
    );
    if (
      existingLine &&
      existingLine.kind === "assistant" &&
      "phase" in existingLine &&
      (existingLine.phase === "finished" || hasPriorOtidAlias)
    ) {
      canonical = otid;
    }
  }

  if (
    canonicalFromMessageId &&
    canonicalFromOtid &&
    canonicalFromMessageId !== canonicalFromOtid
  ) {
    const messageLineExists = b.byId.has(canonicalFromMessageId);
    const otidLineExists = b.byId.has(canonicalFromOtid);

    if (messageLineExists && !otidLineExists) {
      canonical = canonicalFromMessageId;
    } else if (otidLineExists && !messageLineExists) {
      canonical = canonicalFromOtid;
    } else {
      canonical = canonicalFromMessageId;
    }

    debugLog(
      "accumulator",
      `Assistant id/otid alias conflict resolved to ${canonical}`,
    );
  }

  if (messageId) {
    b.assistantCanonicalByMessageId.set(messageId, canonical);
  }
  if (otid) {
    b.assistantCanonicalByOtid.set(otid, canonical);
  }

  const lineId = resolveLineIdForKind(b, canonical, "assistant");
  if (lineId !== canonical) {
    if (messageId) b.assistantCanonicalByMessageId.set(messageId, lineId);
    if (otid) b.assistantCanonicalByOtid.set(otid, lineId);
  }

  return lineId;
}

function resolveReasoningLineId(
  b: Buffers,
  chunk: LettaStreamingResponse & { id?: string; otid?: string },
): string | undefined {
  const messageId = typeof chunk.id === "string" ? chunk.id : undefined;
  const otid = typeof chunk.otid === "string" ? chunk.otid : undefined;

  const canonicalFromMessageId = messageId
    ? b.reasoningCanonicalByMessageId.get(messageId)
    : undefined;
  const canonicalFromOtid = otid
    ? b.reasoningCanonicalByOtid.get(otid)
    : undefined;

  let canonical =
    canonicalFromMessageId || canonicalFromOtid || messageId || otid;
  if (!canonical) return undefined;

  if (otid && !canonicalFromOtid && canonicalFromMessageId) {
    const existingLineId = resolveLineIdForKind(
      b,
      canonicalFromMessageId,
      "reasoning",
    );
    const existingLine = b.byId.get(existingLineId);
    const hasPriorOtidAlias = hasExistingOtidAlias(
      b.reasoningCanonicalByOtid,
      canonicalFromMessageId,
      otid,
    );
    if (
      existingLine &&
      existingLine.kind === "reasoning" &&
      "phase" in existingLine &&
      (existingLine.phase === "finished" || hasPriorOtidAlias)
    ) {
      canonical = otid;
    }
  }

  if (
    canonicalFromMessageId &&
    canonicalFromOtid &&
    canonicalFromMessageId !== canonicalFromOtid
  ) {
    const messageLineExists = b.byId.has(canonicalFromMessageId);
    const otidLineExists = b.byId.has(canonicalFromOtid);

    if (messageLineExists && !otidLineExists) {
      canonical = canonicalFromMessageId;
    } else if (otidLineExists && !messageLineExists) {
      canonical = canonicalFromOtid;
    } else {
      canonical = canonicalFromMessageId;
    }

    debugLog(
      "accumulator",
      `Reasoning id/otid alias conflict resolved to ${canonical}`,
    );
  }

  if (messageId) {
    b.reasoningCanonicalByMessageId.set(messageId, canonical);
  }
  if (otid) {
    b.reasoningCanonicalByOtid.set(otid, canonical);
  }

  const lineId = resolveLineIdForKind(b, canonical, "reasoning");
  if (lineId !== canonical) {
    if (messageId) b.reasoningCanonicalByMessageId.set(messageId, lineId);
    if (otid) b.reasoningCanonicalByOtid.set(otid, lineId);
  }

  return lineId;
}

function trySplitContent(
  b: Buffers,
  id: string,
  kind: "assistant" | "reasoning",
  newText: string,
): boolean {
  if (!b.tokenStreamingEnabled) return false;
  if (kind === "reasoning") return false;

  const splitPoint = findLastSafeSplitPoint(newText);
  if (splitPoint >= newText.length) return false;

  const beforeText = newText.substring(0, splitPoint);
  const afterText = newText.substring(splitPoint);

  const counter = b.splitCounters.get(id) ?? 0;
  b.splitCounters.set(id, counter + 1);

  const commitId = `${id}-split-${counter}`;
  const originalLine = b.byId.get(id);
  const committedLine = {
    kind,
    id: commitId,
    text: beforeText,
    phase: "finished" as const,
    isContinuation: counter > 0,
    messageId:
      originalLine &&
      (originalLine.kind === "assistant" || originalLine.kind === "reasoning")
        ? originalLine.messageId
        : undefined,
  };
  b.byId.set(commitId, committedLine);

  const originalIndex = b.order.indexOf(id);
  if (originalIndex !== -1) {
    b.order.splice(originalIndex, 0, commitId);
  } else {
    b.order.push(commitId);
  }

  if (
    originalLine &&
    (originalLine.kind === "assistant" || originalLine.kind === "reasoning")
  ) {
    b.byId.set(id, { ...originalLine, text: afterText, isContinuation: true });
  }

  return true;
}

function normalizeReasoningSectionBoundaries(text: string): string {
  return text
    .replace(/\*\*\*\*/g, "**\n\n**")
    .replace(/([^\n])(\*\*[^*\n]+\*\*\n\n)/g, "$1\n\n$2");
}

export function onChunk(
  b: Buffers,
  chunk: StreamingChunk,
  ctx?: ContextTracker,
) {
  if (b.interrupted) {
    return;
  }

  switch (chunk.message_type) {
    case "reasoning_message": {
      const chunkWithIds = chunk as LettaStreamingResponse & {
        id?: string;
        otid?: string;
      };
      const id = resolveReasoningLineId(b, chunkWithIds);
      if (!id) {
        break;
      }

      handleOtidTransition(b, id);

      const delta = chunk.reasoning;
      const messageId =
        typeof chunkWithIds.id === "string" ? chunkWithIds.id : undefined;
      const line = ensure(b, id, () => ({
        kind: "reasoning",
        id,
        text: "",
        phase: "streaming",
        messageId,
        startedAtMs: Date.now(),
      }));
      if (delta) {
        const newText = normalizeReasoningSectionBoundaries(line.text + delta);
        b.tokenCount += Buffer.byteLength(delta, "utf8");

        if (!trySplitContent(b, id, "reasoning", newText)) {
          b.byId.set(id, {
            ...line,
            text: newText,
            messageId: messageId ?? line.messageId,
          });
        }
      } else if (messageId && line.messageId !== messageId) {
        b.byId.set(id, { ...line, messageId });
      }
      break;
    }

    case "assistant_message": {
      const chunkWithIds = chunk as LettaStreamingResponse & {
        id?: string;
        otid?: string;
      };
      const id = resolveAssistantLineId(b, chunkWithIds);
      if (!id) break;

      handleOtidTransition(b, id);

      const delta = extractTextPart(chunk.content);
      const messageId =
        typeof chunkWithIds.id === "string" ? chunkWithIds.id : undefined;
      const line = ensure(b, id, () => ({
        kind: "assistant",
        id,
        text: "",
        phase: "streaming",
        messageId,
      }));
      if (delta) {
        const newText = line.text + delta;
        b.tokenCount += Buffer.byteLength(delta, "utf8");

        if (!trySplitContent(b, id, "assistant", newText)) {
          b.byId.set(id, {
            ...line,
            text: newText,
            messageId: messageId ?? line.messageId,
          });
        }
      } else if (messageId && line.messageId !== messageId) {
        b.byId.set(id, { ...line, messageId });
      }
      break;
    }

    case "user_message": {
      const chunkWithIds = chunk as LettaStreamingResponse & {
        id?: string;
        otid?: string;
      };
      const messageId =
        typeof chunkWithIds.id === "string" ? chunkWithIds.id : undefined;
      const otid =
        typeof chunkWithIds.otid === "string" ? chunkWithIds.otid : undefined;
      const mappedLineId = otid ? b.userLineIdByOtid.get(otid) : undefined;
      const lineId = mappedLineId || otid || messageId;
      if (!lineId) break;

      handleOtidTransition(b, lineId);

      const rawText = extractTextPart(chunk.content);
      if (!rawText) break;
      const compactionSummary = extractCompactionSummary(rawText);
      if (compactionSummary) {
        ensure(b, lineId, () => ({
          kind: "event",
          id: lineId,
          eventType: "compaction",
          eventData: {},
          phase: "finished",
          summary: compactionSummary,
        }));
        markCompactionCompleted(ctx);
        break;
      }
      if (!mappedLineId) break;

      const line = b.byId.get(mappedLineId);
      if (line?.kind === "user") {
        b.byId.set(mappedLineId, {
          ...line,
          text: line.text || rawText,
          messageId: messageId ?? line.messageId,
          otid: otid ?? line.otid,
        });
      }
      break;
    }

    case "tool_call_message":
    case "approval_request_message": {
      handleOtidTransition(b, chunk.otid ?? undefined);

      const toolCall =
        chunk.tool_call ||
        (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0
          ? chunk.tool_calls[0]
          : null);
      if (!toolCall || !toolCall.tool_call_id) break;

      const toolCallId = toolCall.tool_call_id;
      const name = toolCall.name;
      const argsText = toolCall.arguments;

      const id = b.toolCallIdToLineId.get(toolCallId) ?? toolCallId;
      if (!b.toolCallIdToLineId.has(toolCallId)) {
        b.toolCallIdToLineId.set(toolCallId, id);
      }

      const desiredPhase = "streaming";
      let line = ensure<ToolCallLine>(b, id, () => ({
        kind: "tool_call",
        id,
        toolCallId,
        name: name ?? undefined,
        phase: desiredPhase,
      }));

      if ((name && !line.name) || line.toolCallId !== toolCallId) {
        line = {
          ...line,
          toolCallId,
          name: line.name ?? name ?? undefined,
        };
        b.byId.set(id, line);
      }

      if (
        chunk.message_type === "approval_request_message" &&
        line.phase !== "finished"
      ) {
        b.approvalsPending = true;
        line = { ...line, phase: "ready" };
        b.byId.set(id, line);

        for (const [toolCallId] of b.serverToolCalls) {
          const serverLineId = b.toolCallIdToLineId.get(toolCallId);
          if (!serverLineId) continue;
          const serverLine = b.byId.get(serverLineId);
          if (
            serverLine &&
            serverLine.kind === "tool_call" &&
            serverLine.phase === "running"
          ) {
            b.byId.set(serverLineId, { ...serverLine, phase: "streaming" });
          }
        }
      }

      if (argsText !== undefined && argsText !== null) {
        const updatedLine = {
          ...line,
          argsText: (line.argsText || "") + argsText,
        };
        line = annotateWriteStdinCommandDisplay(b, updatedLine);
        b.byId.set(id, line);
        b.tokenCount += Buffer.byteLength(argsText, "utf8");
      }

      if (chunk.message_type === "tool_call_message" && toolCallId) {
        const existing = b.serverToolCalls.get(toolCallId);
        const toolInfo: ServerToolCallInfo = existing || {
          toolName: "",
          toolArgs: "",
          preToolUseTriggered: false,
        };

        if (name) toolInfo.toolName = name;
        if (argsText) toolInfo.toolArgs += argsText;
        b.serverToolCalls.set(toolCallId, toolInfo);

        if (toolInfo.toolName && !toolInfo.preToolUseTriggered) {
          toolInfo.preToolUseTriggered = true;
          let parsedArgs: Record<string, unknown> = {};
          try {
            if (toolInfo.toolArgs) {
              parsedArgs = JSON.parse(toolInfo.toolArgs);
            }
          } catch {}
          runPreToolUseHooks(
            toolInfo.toolName,
            parsedArgs,
            toolCallId,
            undefined,
            b.agentId,
          ).catch((error) => {
            debugLog("hooks", "PreToolUse hook error (accumulator)", error);
          });
        }
      }

      break;
    }

    case "tool_return_message": {
      const toolReturns =
        Array.isArray(chunk.tool_returns) && chunk.tool_returns.length > 0
          ? chunk.tool_returns
          : chunk.tool_call_id
            ? [
                {
                  tool_call_id: chunk.tool_call_id,
                  status: chunk.status,
                  func_response: chunk.tool_return,
                },
              ]
            : [];

      for (const toolReturn of toolReturns) {
        const toolCallId = toolReturn.tool_call_id;
        const rawResult =
          ("func_response" in toolReturn
            ? toolReturn.func_response
            : undefined) ||
          ("tool_return" in toolReturn ? toolReturn.tool_return : undefined);

        const resultText = clampRawToolReturn(
          rawResult,
          toolCallId ? b.serverToolCalls.get(toolCallId)?.toolName : undefined,
        );
        const status = toolReturn.status;

        const id = toolCallId
          ? b.toolCallIdToLineId.get(toolCallId)
          : undefined;
        if (!id) continue;

        let line = ensure<ToolCallLine>(b, id, () => ({
          kind: "tool_call",
          id,
          phase: "finished",
        }));

        line = annotateWriteStdinCommandDisplay(b, line);

        const updatedLine = {
          ...line,
          resultText,
          phase: "finished" as const,
          resultOk: status === "success",
        };
        b.byId.set(id, updatedLine);

        if (updatedLine.name === "exec_command") {
          const sessionId = extractUnifiedExecRunningSessionId(resultText);
          const commandDisplay = extractExecCommandDisplay(
            updatedLine.argsText,
          );
          if (sessionId && commandDisplay) {
            b.unifiedExecSessionCommands.set(sessionId, commandDisplay);
          }
        }

        if (toolCallId) {
          const serverToolInfo = b.serverToolCalls.get(toolCallId);
          if (serverToolInfo) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              if (serverToolInfo.toolArgs) {
                parsedArgs = JSON.parse(serverToolInfo.toolArgs);
              }
            } catch {}

            const precedingReasoning = b.lastReasoning;
            const precedingAssistantMessage = b.lastAssistantMessage;
            b.lastReasoning = undefined;
            b.lastAssistantMessage = undefined;

            runPostToolUseHooks(
              serverToolInfo.toolName,
              parsedArgs,
              {
                status: status === "success" ? "success" : "error",
                output: resultText,
              },
              toolCallId,
              undefined,
              b.agentId,
              precedingReasoning,
              precedingAssistantMessage,
            ).catch((error) => {
              debugLog("hooks", "PostToolUse hook error (accumulator)", error);
            });

            b.serverToolCalls.delete(toolCallId);
          }
        }
      }
      break;
    }

    case "usage_statistics": {
      if (chunk.prompt_tokens !== undefined) {
        b.usage.promptTokens += chunk.prompt_tokens;
      }
      if (chunk.completion_tokens !== undefined) {
        b.usage.completionTokens += chunk.completion_tokens;
      }
      if (chunk.total_tokens !== undefined) {
        b.usage.totalTokens += chunk.total_tokens;
      }
      if (
        chunk.cached_input_tokens !== undefined &&
        chunk.cached_input_tokens !== null
      ) {
        b.usage.cachedInputTokens += chunk.cached_input_tokens;
      }
      if (
        chunk.cache_write_tokens !== undefined &&
        chunk.cache_write_tokens !== null
      ) {
        b.usage.cacheWriteTokens += chunk.cache_write_tokens;
      }
      if (
        chunk.reasoning_tokens !== undefined &&
        chunk.reasoning_tokens !== null
      ) {
        b.usage.reasoningTokens += chunk.reasoning_tokens;
      }
      const usageChunk = chunk as typeof chunk & {
        context_tokens?: number | null;
      };
      if (
        usageChunk.context_tokens !== undefined &&
        usageChunk.context_tokens !== null
      ) {
        b.usage.contextTokens = usageChunk.context_tokens;
      }
      if (ctx) {
        if (
          usageChunk.context_tokens !== undefined &&
          usageChunk.context_tokens !== null
        ) {
          ctx.lastContextTokens = usageChunk.context_tokens;
          const compacted = ctx.pendingCompaction;
          if (compacted) ctx.pendingCompaction = false;
          ctx.contextTokensHistory.push({
            timestamp: Date.now(),
            tokens: usageChunk.context_tokens,
            turnId: ctx.currentTurnId,
            ...(compacted ? { compacted: true } : {}),
          });
          if (ctx.contextTokensHistory.length > MAX_CONTEXT_HISTORY) {
            ctx.contextTokensHistory = ctx.contextTokensHistory.slice(
              -MAX_CONTEXT_HISTORY,
            );
          }
        }
      }
      if (chunk.step_count !== undefined) {
        b.usage.stepCount += chunk.step_count;
      }
      break;
    }

    default: {
      const msgType = chunk.message_type as string | undefined;

      if (msgType === "summary_message") {
        const summaryChunk = chunk as LettaStreamingResponse & {
          id?: string;
          otid?: string;
          summary?: string;
          compaction_stats?: {
            trigger?: string;
            context_tokens_before?: number;
            context_tokens_after?: number;
            context_window?: number;
            messages_count_before?: number;
            messages_count_after?: number;
          };
        };
        const summaryText = summaryChunk.summary || "";
        const stats = summaryChunk.compaction_stats;

        for (let i = b.order.length - 1; i >= 0; i--) {
          const orderId = b.order[i];
          if (!orderId) continue;
          const line = b.byId.get(orderId);
          if (line?.kind === "event" && line.eventType === "compaction") {
            line.phase = "finished";
            line.summary = summaryText;
            if (stats) {
              line.stats = {
                trigger: stats.trigger,
                contextTokensBefore: stats.context_tokens_before,
                contextTokensAfter: stats.context_tokens_after,
                contextWindow: stats.context_window,
                messagesCountBefore: stats.messages_count_before,
                messagesCountAfter: stats.messages_count_after,
              };
            }
            break;
          }
        }

        markCompactionCompleted(ctx);
        break;
      }

      if (msgType === "event_message") {
        const eventChunk = chunk as LettaStreamingResponse & {
          id?: string;
          otid?: string;
          run_id?: string;
          seq_id?: number;
          event_type?: string;
          event_data?: Record<string, unknown>;
        };
        const eventType = eventChunk.event_type || "unknown";
        const eventData = eventChunk.event_data || {};
        const id =
          eventChunk.otid ||
          eventChunk.id ||
          (eventType === "retry" && eventChunk.run_id && eventChunk.seq_id
            ? `${eventChunk.run_id}-retry-${eventChunk.seq_id}`
            : undefined);
        if (!id) break;

        handleOtidTransition(b, id);

        if (eventType === "retry") {
          upsertStatusLine(b, id, formatRetryEventStatusLines(eventData));
          break;
        }

        ensure(b, id, () => ({
          kind: "event",
          id,
          eventType,
          eventData,
          phase: eventType === "compaction" ? "running" : "finished",
        }));

        if (eventType === "compaction") {
          runPreCompactHooks(
            ctx?.lastContextTokens,
            undefined,
            b.agentId,
            undefined,
          ).catch((error) => {
            debugLog("hooks", "PreCompact hook error (accumulator)", error);
          });
        }

        break;
      }

      break;
    }
  }
}

export function toLines(b: Buffers): Line[] {
  const out: Line[] = [];
  for (const id of b.order) {
    const line = b.byId.get(id);
    if (line) out.push(line);
  }
  return out;
}

export function findLastAssistantText(lines: Line[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (
      line?.kind === "assistant" &&
      "text" in line &&
      typeof line.text === "string" &&
      line.text.trim().length > 0
    ) {
      return line.text;
    }
  }
  return undefined;
}

export function setToolCallsRunning(b: Buffers, toolCallIds: string[]): void {
  for (const toolCallId of toolCallIds) {
    const lineId = b.toolCallIdToLineId.get(toolCallId);
    if (lineId) {
      const line = b.byId.get(lineId);
      if (line && line.kind === "tool_call") {
        const shouldSeedStreaming =
          line.name && isShellOutputTool(line.name) && !line.streaming;
        b.byId.set(lineId, {
          ...line,
          phase: "running",
          ...(shouldSeedStreaming
            ? {
                streaming: {
                  tailLines: [],
                  partialLine: "",
                  partialIsStderr: false,
                  totalLineCount: 0,
                  startTime: Date.now(),
                },
              }
            : {}),
        });
      }
    }
  }
}

export function linesToTranscript(lines: Line[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    switch (line.kind) {
      case "user":
        parts.push(`<user>${line.text}</user>`);
        break;
      case "assistant":
        parts.push(`<assistant>${line.text}</assistant>`);
        break;
      case "reasoning":
        parts.push(`<reasoning>${line.text}</reasoning>`);
        break;
      case "tool_call":
        if (line.name) {
          const args = line.argsText ? `\n${line.argsText}` : "";
          const result = line.resultText
            ? `\n<tool_result>${line.resultText}</tool_result>`
            : "";
          parts.push(
            `<tool_call name="${line.name}">${args}${result}</tool_call>`,
          );
        }
        break;
      case "error":
        parts.push(`<error>${line.text}</error>`);
        break;
      default:
        break;
    }
  }
  return parts.join("\n");
}
