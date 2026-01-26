// src/cli/accumulator.ts
// Minimal, token-aware accumulator for Letta streams.
// - Single transcript via { order[], byId: Map }.
// - Tool calls update in-place (same toolCallId for call+return).
// - Exposes `onChunk` to feed SDK events and `toLines` to render.

import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { INTERRUPTED_BY_USER } from "../../constants";
import { runPostToolUseHooks, runPreToolUseHooks } from "../../hooks";
import { findLastSafeSplitPoint } from "./markdownSplit";
import { isShellTool } from "./toolNameMapping";

// Constants for streaming output
const MAX_TAIL_LINES = 5;
const MAX_BUFFER_SIZE = 100_000; // 100KB

/**
 * A line of streaming output with its source (stdout or stderr).
 */
export interface StreamingLine {
  text: string;
  isStderr: boolean;
}

/**
 * Streaming state for bash/shell tools.
 * Tracks a rolling window of output during execution.
 */
export interface StreamingState {
  tailLines: StreamingLine[]; // Last 5 complete lines (for rolling display)
  partialLine: string; // Incomplete line being accumulated
  partialIsStderr: boolean; // Whether partial line is from stderr
  totalLineCount: number; // Total lines seen (for "+N more" count)
  startTime: number; // For elapsed time display
}

/**
 * Append a chunk of output to the streaming state.
 * Maintains a tail buffer of the last N lines and handles partial line accumulation.
 */
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

  // If stream type changed and we have a partial, flush it as a complete line
  if (partialLine && isStderr !== partialIsStderr) {
    tailLines.push({ text: partialLine, isStderr: partialIsStderr });
    totalLineCount++;
    partialLine = "";
  }

  // Append chunk to partial line
  let buffer = partialLine + chunk;

  // Size limit check - slice at line boundary to avoid corrupted lines
  if (buffer.length > MAX_BUFFER_SIZE) {
    const truncated = buffer.slice(-MAX_BUFFER_SIZE);
    const firstNewline = truncated.indexOf("\n");
    buffer = firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated;
  }

  // Split into complete lines + remainder
  const lines = buffer.split("\n");
  const newPartialLine = lines.pop() || ""; // Last element is incomplete

  // Convert string lines to StreamingLine objects with current stream's stderr flag
  const newLines: StreamingLine[] = lines.map((text) => ({
    text,
    isStderr,
  }));

  // Update tail with new complete lines (keep empty lines for accurate display)
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

// One line per transcript row. Tool calls evolve in-place.
// For tool call returns, merge into the tool call matching the toolCallId
export type Line =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "reasoning";
      id: string;
      text: string;
      phase: "streaming" | "finished";
      isContinuation?: boolean; // true for split continuation lines (no header)
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      phase: "streaming" | "finished";
      isContinuation?: boolean; // true for split continuation lines (no bullet)
    }
  | {
      kind: "tool_call";
      id: string;
      // from the tool call object
      // toolCallId and name should come in the very first chunk
      toolCallId?: string;
      name?: string;
      argsText?: string;
      // from the tool return object
      resultText?: string;
      resultOk?: boolean;
      // state that's useful for rendering
      phase: "streaming" | "ready" | "running" | "finished";
      // streaming output state (for shell tools during execution)
      streaming?: StreamingState;
    }
  | { kind: "error"; id: string; text: string }
  | {
      kind: "command";
      id: string;
      input: string;
      output: string;
      phase?: "running" | "finished";
      success?: boolean;
      dimOutput?: boolean;
    }
  | {
      kind: "bash_command";
      id: string;
      input: string;
      output: string;
      phase?: "running" | "finished";
      success?: boolean;
      // streaming output state (during execution)
      streaming?: StreamingState;
    }
  | {
      kind: "status";
      id: string;
      lines: string[]; // Multi-line status message with arrow formatting
    }
  | { kind: "separator"; id: string };

/**
 * Tracks server-side tool calls for hook triggering.
 * Server-side tools (tool_call_message) are executed by the Letta server,
 * not the client, so we need to trigger hooks when we receive the stream messages.
 */
export interface ServerToolCallInfo {
  toolName: string;
  toolArgs: string;
  preToolUseTriggered: boolean;
}

// Top-level state object for all streaming events
export type Buffers = {
  tokenCount: number;
  order: string[];
  byId: Map<string, Line>;
  pendingToolByRun: Map<string, string>; // temporary id per run until real id
  toolCallIdToLineId: Map<string, string>;
  lastOtid: string | null; // Track the last otid to detect transitions
  pendingRefresh?: boolean; // Track throttled refresh state
  interrupted?: boolean; // Track if stream was interrupted by user (skip stale refreshes)
  commitGeneration?: number; // Incremented when resuming from error to invalidate pending refreshes
  abortGeneration?: number; // Incremented on each interrupt to detect cancellation across async boundaries
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    stepCount: number;
  };
  // Aggressive static promotion: split streaming content at paragraph boundaries
  tokenStreamingEnabled?: boolean;
  splitCounters: Map<string, number>; // tracks split count per original otid
  // Track server-side tool calls for hook triggering (toolCallId -> info)
  serverToolCalls: Map<string, ServerToolCallInfo>;
  // Agent ID for passing to hooks (needed for server-side tools like memory)
  agentId?: string;
};

export function createBuffers(agentId?: string): Buffers {
  return {
    tokenCount: 0,
    order: [],
    byId: new Map(),
    pendingToolByRun: new Map(),
    toolCallIdToLineId: new Map(),
    lastOtid: null,
    commitGeneration: 0,
    abortGeneration: 0,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      stepCount: 0,
    },
    tokenStreamingEnabled: false,
    splitCounters: new Map(),
    serverToolCalls: new Map(),
    agentId,
  };
}

// Guarantees that there's only one line per ID
// If byId already has that id, returns the Line (for mutation)
// If not, makes a new line and adds it
function ensure<T extends Line>(b: Buffers, id: string, make: () => T): T {
  const existing = b.byId.get(id) as T | undefined;
  if (existing) return existing;
  const created = make();
  b.byId.set(id, created);
  b.order.push(id);
  return created;
}

// Mark a line as finished if it has a phase (immutable update)
function markAsFinished(b: Buffers, id: string) {
  const line = b.byId.get(id);
  // console.log(`[MARK_FINISHED] Called for ${id}, line exists: ${!!line}, kind: ${line?.kind}, phase: ${(line as any)?.phase}`);
  if (line && "phase" in line && line.phase === "streaming") {
    const updatedLine = { ...line, phase: "finished" as const };
    b.byId.set(id, updatedLine);
    // console.log(`[MARK_FINISHED] Successfully marked ${id} as finished`);
  } else {
    // console.log(`[MARK_FINISHED] Did NOT mark ${id} as finished (conditions not met)`);
  }
}

// Helper to mark previous otid's line as finished when transitioning to new otid
function handleOtidTransition(b: Buffers, newOtid: string | undefined) {
  // console.log(`[OTID_TRANSITION] Called with newOtid=${newOtid}, lastOtid=${b.lastOtid}`);

  // If transitioning to a different otid (including null/undefined), finish only assistant/reasoning lines.
  // Tool calls should finish exclusively when a tool_return arrives (merged by toolCallId).
  if (b.lastOtid && b.lastOtid !== newOtid) {
    const prev = b.byId.get(b.lastOtid);
    // console.log(`[OTID_TRANSITION] Found prev line: kind=${prev?.kind}, phase=${(prev as any)?.phase}`);
    if (prev && (prev.kind === "assistant" || prev.kind === "reasoning")) {
      // console.log(`[OTID_TRANSITION] Marking ${b.lastOtid} as finished (was ${(prev as any).phase})`);
      markAsFinished(b, b.lastOtid);
    }
  }

  // Update last otid (can be null)
  b.lastOtid = newOtid ?? null;
  // console.log(`[OTID_TRANSITION] Updated lastOtid to ${b.lastOtid}`);
}

/**
 * Mark the current (last) line as finished when the stream ends.
 * Call this after stream completion to ensure the final line isn't stuck in "streaming" state.
 */
export function markCurrentLineAsFinished(b: Buffers) {
  // console.log(`[MARK_CURRENT_FINISHED] Called with lastOtid=${b.lastOtid}`);
  if (!b.lastOtid) {
    // console.log(`[MARK_CURRENT_FINISHED] No lastOtid, returning`);
    return;
  }
  // Try both the plain otid and the -tool suffix (in case of collision workaround)
  const prev = b.byId.get(b.lastOtid) || b.byId.get(`${b.lastOtid}-tool`);
  // console.log(`[MARK_CURRENT_FINISHED] Found line: kind=${prev?.kind}, phase=${(prev as any)?.phase}`);
  if (prev && (prev.kind === "assistant" || prev.kind === "reasoning")) {
    // console.log(`[MARK_CURRENT_FINISHED] Marking ${b.lastOtid} as finished`);
    markAsFinished(b, b.lastOtid);
  } else {
    // console.log(`[MARK_CURRENT_FINISHED] Not marking (not assistant/reasoning or doesn't exist)`);
  }
}

/**
 * Mark any incomplete tool calls as cancelled when stream is interrupted.
 * This prevents blinking tool calls from staying in progress state.
 * @param b - The buffers object
 * @param setInterruptedFlag - Whether to set the interrupted flag (default true).
 *   Pass false when clearing stale tool calls at stream startup to avoid race conditions
 *   with concurrent processConversation calls reading the flag.
 * @returns true if any tool calls were marked as cancelled
 */
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
): boolean {
  // Mark buffer as interrupted to skip stale throttled refreshes
  // (only when actually interrupting, not when clearing stale state at startup)
  if (setInterruptedFlag) {
    b.interrupted = true;
  }

  let anyToolsCancelled = false;
  for (const [id, line] of b.byId.entries()) {
    if (line.kind === "tool_call" && line.phase !== "finished") {
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
  // Also mark any streaming assistant/reasoning lines as finished
  markCurrentLineAsFinished(b);
  return anyToolsCancelled;
}

type ToolCallLine = Extract<Line, { kind: "tool_call" }>;

// Flatten common SDK "parts" → text
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}
function getStringProp(obj: Record<string, unknown>, key: string) {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}
function extractTextPart(v: unknown): string {
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

/**
 * Attempts to split content at a paragraph boundary for aggressive static promotion.
 * If split found, creates a committed line for "before" and updates original with "after".
 * Returns true if split occurred, false otherwise.
 */
function trySplitContent(
  b: Buffers,
  id: string,
  kind: "assistant" | "reasoning",
  newText: string,
): boolean {
  if (!b.tokenStreamingEnabled) return false;

  const splitPoint = findLastSafeSplitPoint(newText);
  if (splitPoint >= newText.length) return false; // No safe split point

  const beforeText = newText.substring(0, splitPoint);
  const afterText = newText.substring(splitPoint);

  // Get or initialize split counter for this original ID
  const counter = b.splitCounters.get(id) ?? 0;
  b.splitCounters.set(id, counter + 1);

  // Create committed line for "before" content
  // Only the first split (counter=0) shows the bullet/header; subsequent splits are continuations
  const commitId = `${id}-split-${counter}`;
  const committedLine = {
    kind,
    id: commitId,
    text: beforeText,
    phase: "finished" as const,
    isContinuation: counter > 0, // First split shows bullet, subsequent don't
  };
  b.byId.set(commitId, committedLine);

  // Insert committed line BEFORE the original in order array
  const originalIndex = b.order.indexOf(id);
  if (originalIndex !== -1) {
    b.order.splice(originalIndex, 0, commitId);
  } else {
    // Should not happen, but handle gracefully
    b.order.push(commitId);
  }

  // Update original line with just the "after" content (keep streaming)
  // Mark it as a continuation so it doesn't show bullet/header
  const originalLine = b.byId.get(id);
  if (
    originalLine &&
    (originalLine.kind === "assistant" || originalLine.kind === "reasoning")
  ) {
    b.byId.set(id, { ...originalLine, text: afterText, isContinuation: true });
  }

  return true;
}

// Feed one SDK chunk; mutate buffers in place.
export function onChunk(b: Buffers, chunk: LettaStreamingResponse) {
  // Skip processing if stream was interrupted mid-turn. handleInterrupt already
  // rendered the cancellation state, so we should ignore any buffered chunks
  // that arrive before drainStream exits.
  if (b.interrupted) {
    return;
  }

  // TODO remove once SDK v1 has proper typing for in-stream errors
  // Check for streaming error objects (not typed in SDK but emitted by backend)
  // Note: Error handling moved to catch blocks in App.tsx and headless.ts
  // The SDK now throws APIError when it sees event: error, so chunks never have error property

  switch (chunk.message_type) {
    case "reasoning_message": {
      const id = chunk.otid;
      // console.log(`[REASONING] Received chunk with otid=${id}, delta="${chunk.reasoning?.substring(0, 50)}..."`);
      if (!id) {
        // console.log(`[REASONING] No otid, breaking`);
        break;
      }

      // Handle otid transition (mark previous line as finished)
      handleOtidTransition(b, id);

      const delta = chunk.reasoning;
      const line = ensure(b, id, () => ({
        kind: "reasoning",
        id,
        text: "",
        phase: "streaming",
      }));
      if (delta) {
        const newText = line.text + delta;
        b.tokenCount += delta.length;

        // Try to split at paragraph boundary (only if streaming enabled)
        if (!trySplitContent(b, id, "reasoning", newText)) {
          // No split - normal accumulation
          b.byId.set(id, { ...line, text: newText });
        }
        // console.log(`[REASONING] Updated ${id}, textLen=${newText.length}`);
      }
      break;
    }

    case "assistant_message": {
      const id = chunk.otid;
      if (!id) break;

      // Handle otid transition (mark previous line as finished)
      handleOtidTransition(b, id);

      const delta = extractTextPart(chunk.content); // NOTE: may be list of parts
      const line = ensure(b, id, () => ({
        kind: "assistant",
        id,
        text: "",
        phase: "streaming",
      }));
      if (delta) {
        const newText = line.text + delta;
        b.tokenCount += delta.length;

        // Try to split at paragraph boundary (only if streaming enabled)
        if (!trySplitContent(b, id, "assistant", newText)) {
          // No split - normal accumulation
          b.byId.set(id, { ...line, text: newText });
        }
      }
      break;
    }

    case "tool_call_message":
    case "approval_request_message": {
      /* POST-FIX VERSION (what this should look like after backend fix):
      const id = chunk.otid;

      // Handle otid transition (mark previous line as finished)
      handleOtidTransition(b, id);

      if (!id) break;

      const toolCall = chunk.tool_call || (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0 ? chunk.tool_calls[0] : null);
      const toolCallId = toolCall?.tool_call_id;
      const name = toolCall?.name;
      const argsText = toolCall?.arguments;

      // Record correlation: toolCallId → line id (otid)
      if (toolCallId) b.toolCallIdToLineId.set(toolCallId, id);
      */

      let id = chunk.otid;
      // console.log(`[TOOL_CALL] Received ${chunk.message_type} with otid=${id}, toolCallId=${chunk.tool_call?.tool_call_id}, name=${chunk.tool_call?.name}`);

      // Use deprecated tool_call or new tool_calls array
      const toolCall =
        chunk.tool_call ||
        (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0
          ? chunk.tool_calls[0]
          : null);

      const toolCallId = toolCall?.tool_call_id;
      const name = toolCall?.name;
      const argsText = toolCall?.arguments;

      // ========== START BACKEND BUG WORKAROUND (Remove after OTID fix) ==========
      // Bug: Backend sends same otid for reasoning and tool_call, and multiple otids for same tool_call

      // Check if we already have a line for this toolCallId (prevents duplicates)
      if (toolCallId && b.toolCallIdToLineId.has(toolCallId)) {
        // Update the existing line instead of creating a new one
        const existingId = b.toolCallIdToLineId.get(toolCallId);
        if (existingId) {
          id = existingId;
        }

        // Handle otid transition for tracking purposes
        handleOtidTransition(b, chunk.otid ?? undefined);
      } else {
        // Check if this otid is already used by another line
        if (id && b.byId.has(id)) {
          const existing = b.byId.get(id);
          if (existing && existing.kind === "reasoning") {
            // Mark the reasoning as finished before we create the tool_call
            markAsFinished(b, id);
            // Use a different ID for the tool_call to avoid overwriting the reasoning
            id = `${id}-tool`;
          } else if (existing && existing.kind === "tool_call") {
            // Parallel tool calls: same otid, different tool_call_id
            // Create unique ID for this parallel tool using its tool_call_id
            if (toolCallId) {
              id = `${id}-${toolCallId.slice(-8)}`;
            } else {
              // Fallback: append timestamp
              id = `${id}-${Date.now().toString(36)}`;
            }
          }
        }
        // ========== END BACKEND BUG WORKAROUND ==========

        // This part stays after fix:
        // Handle otid transition (mark previous line as finished)
        // This must happen BEFORE the break, so reasoning gets finished even when tool has no otid
        handleOtidTransition(b, id ?? undefined);

        if (!id) {
          // console.log(`[TOOL_CALL] No otid, breaking`);
          break;
        }

        // Record correlation: toolCallId → line id (otid) for future updates
        if (toolCallId) b.toolCallIdToLineId.set(toolCallId, id);
      }

      // Early exit if no valid id
      if (!id) break;

      // Tool calls should be "ready" (blinking) while pending execution
      // Only approval requests explicitly set to "ready", but regular tool calls should also blink
      const desiredPhase = "ready";
      const line = ensure<ToolCallLine>(b, id, () => ({
        kind: "tool_call",
        id,
        toolCallId: toolCallId ?? undefined,
        name: name ?? undefined,
        phase: desiredPhase,
      }));

      // If this is an approval request and the line already exists, bump phase to ready
      if (
        chunk.message_type === "approval_request_message" &&
        line.phase !== "finished"
      ) {
        b.byId.set(id, { ...line, phase: "ready" });
      }

      // if argsText is not empty, add it to the line (immutable update)
      // Skip if argsText is undefined or null (backend sometimes sends null)
      if (argsText !== undefined && argsText !== null) {
        const updatedLine = {
          ...line,
          argsText: (line.argsText || "") + argsText,
        };
        b.byId.set(id, updatedLine);
        // Count tool call arguments as LLM output tokens
        b.tokenCount += argsText.length;
      }

      // Track server-side tools and trigger PreToolUse hook (fire-and-forget since execution already started)
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
          } catch {
            // Args may be incomplete JSON
          }
          runPreToolUseHooks(
            toolInfo.toolName,
            parsedArgs,
            toolCallId,
            undefined,
            b.agentId,
          ).catch(() => {});
        }
      }

      break;
    }

    case "tool_return_message": {
      // Tool return is a special case
      // It will have a different otid than the tool call, but we want to merge into the tool call

      // Handle parallel tool returns: check tool_returns array first, fallback to singular fields
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
        // Handle both func_response (streaming) and tool_return (SDK) properties
        const rawResult =
          ("func_response" in toolReturn
            ? toolReturn.func_response
            : undefined) ||
          ("tool_return" in toolReturn ? toolReturn.tool_return : undefined);

        // Ensure resultText is always a string (guard against SDK returning objects)
        const resultText =
          typeof rawResult === "string"
            ? rawResult
            : rawResult != null
              ? JSON.stringify(rawResult)
              : "";
        const status = toolReturn.status;

        // Look up the line by toolCallId
        // Keep a mapping of toolCallId to line id (otid)
        const id = toolCallId
          ? b.toolCallIdToLineId.get(toolCallId)
          : undefined;
        if (!id) continue;

        const line = ensure<ToolCallLine>(b, id, () => ({
          kind: "tool_call",
          id,
          phase: "finished",
        }));

        // Immutable update: create new object with result
        const updatedLine = {
          ...line,
          resultText,
          phase: "finished" as const,
          resultOk: status === "success",
        };
        b.byId.set(id, updatedLine);

        // Trigger PostToolUse hook for server-side tools (fire-and-forget)
        if (toolCallId) {
          const serverToolInfo = b.serverToolCalls.get(toolCallId);
          if (serverToolInfo) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              if (serverToolInfo.toolArgs) {
                parsedArgs = JSON.parse(serverToolInfo.toolArgs);
              }
            } catch {
              // Args parsing failed
            }

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
            ).catch(() => {});

            b.serverToolCalls.delete(toolCallId);
          }
        }
      }
      break;
    }

    case "usage_statistics": {
      // Accumulate usage statistics from the stream
      // These messages arrive after stop_reason in the stream
      if (chunk.prompt_tokens !== undefined) {
        b.usage.promptTokens += chunk.prompt_tokens;
      }
      if (chunk.completion_tokens !== undefined) {
        b.usage.completionTokens += chunk.completion_tokens;
      }
      if (chunk.total_tokens !== undefined) {
        b.usage.totalTokens += chunk.total_tokens;
      }
      if (chunk.step_count !== undefined) {
        b.usage.stepCount += chunk.step_count;
      }
      break;
    }

    default:
      break; // ignore ping/etc
  }
}

// Derive a flat transcript
export function toLines(b: Buffers): Line[] {
  const out: Line[] = [];
  for (const id of b.order) {
    const line = b.byId.get(id);
    if (line) out.push(line);
  }
  return out;
}

/**
 * Set tool calls to "running" phase before execution.
 * This updates the UI to show the formatted args instead of ellipsis.
 */
export function setToolCallsRunning(b: Buffers, toolCallIds: string[]): void {
  for (const toolCallId of toolCallIds) {
    const lineId = b.toolCallIdToLineId.get(toolCallId);
    if (lineId) {
      const line = b.byId.get(lineId);
      if (line && line.kind === "tool_call") {
        const shouldSeedStreaming =
          line.name && isShellTool(line.name) && !line.streaming;
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
