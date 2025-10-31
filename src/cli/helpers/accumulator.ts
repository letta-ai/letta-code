// src/cli/accumulator.ts
// Minimal, token-aware accumulator for Letta streams.
// - Single transcript via { order[], byId: Map }.
// - Tool calls update in-place (same toolCallId for call+return).
// - Exposes `onChunk` to feed SDK events and `toLines` to render.

import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";

// One line per transcript row. Tool calls evolve in-place.
// For tool call returns, merge into the tool call matching the toolCallId
export type Line =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "reasoning";
      id: string;
      text: string;
      phase: "streaming" | "finished";
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      phase: "streaming" | "finished";
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
    }
  | { kind: "error"; id: string; text: string }
  | {
      kind: "command";
      id: string;
      input: string;
      output: string;
      phase?: "running" | "finished";
      success?: boolean;
    };

// Top-level state object for all streaming events
export type Buffers = {
  tokenCount: number;
  order: string[];
  byId: Map<string, Line>;
  pendingToolByRun: Map<string, string>; // temporary id per run until real id
  toolCallIdToLineId: Map<string, string>;
  lastOtid: string | null; // Track the last otid to detect transitions
  pendingRefresh?: boolean; // Track throttled refresh state
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    stepCount: number;
  };
};

export function createBuffers(): Buffers {
  return {
    tokenCount: 0,
    order: [],
    byId: new Map(),
    pendingToolByRun: new Map(),
    toolCallIdToLineId: new Map(),
    lastOtid: null,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      stepCount: 0,
    },
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
 */
export function markIncompleteToolsAsCancelled(b: Buffers) {
  for (const [id, line] of b.byId.entries()) {
    if (line.kind === "tool_call" && line.phase !== "finished") {
      const updatedLine = {
        ...line,
        phase: "finished" as const,
        resultOk: false,
        resultText: "Interrupted by user",
      };
      b.byId.set(id, updatedLine);
    }
  }
  // Also mark any streaming assistant/reasoning lines as finished
  markCurrentLineAsFinished(b);
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

// Feed one SDK chunk; mutate buffers in place.
export function onChunk(b: Buffers, chunk: LettaStreamingResponse) {
  // TODO remove once SDK v1 has proper typing for in-stream errors
  // Check for streaming error objects (not typed in SDK but emitted by backend)
  // These are emitted when LLM errors occur during streaming (rate limits, timeouts, etc.)
  const chunkWithError = chunk as typeof chunk & {
    error?: { message?: string; detail?: string };
  };
  if (chunkWithError.error && !chunk.message_type) {
    const errorId = `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const errorMsg = chunkWithError.error.message || "An error occurred";
    const errorDetail = chunkWithError.error.detail || "";
    const fullErrorText = errorDetail
      ? `${errorMsg}: ${errorDetail}`
      : errorMsg;

    b.byId.set(errorId, {
      kind: "error",
      id: errorId,
      text: `⚠ ${fullErrorText}`,
    });
    b.order.push(errorId);
    return;
  }

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
        // Immutable update: create new object with updated text
        const updatedLine = { ...line, text: line.text + delta };
        b.byId.set(id, updatedLine);
        b.tokenCount += delta.length;
        // console.log(`[REASONING] Updated ${id}, phase=${updatedLine.phase}, textLen=${updatedLine.text.length}`);
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
        // Immutable update: create new object with updated text
        const updatedLine = { ...line, text: line.text + delta };
        b.byId.set(id, updatedLine);
        b.tokenCount += delta.length;
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
        // Check if this otid is already used by a reasoning line
        if (id && b.byId.has(id)) {
          const existing = b.byId.get(id);
          if (existing && existing.kind === "reasoning") {
            // Mark the reasoning as finished before we create the tool_call
            markAsFinished(b, id);
            // Use a different ID for the tool_call to avoid overwriting the reasoning
            id = `${id}-tool`;
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

      const desiredPhase =
        chunk.message_type === "approval_request_message"
          ? "ready"
          : "streaming";
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
      }
      break;
    }

    case "tool_return_message": {
      // Tool return is a special case
      // It will have a different otid than the tool call, but we want to merge into the tool call
      const toolCallId = chunk.tool_call_id;
      const resultText = chunk.tool_return;
      const status = chunk.status;

      // Look up the line by toolCallId
      // Keep a mapping of toolCallId to line id (otid)
      const id = toolCallId ? b.toolCallIdToLineId.get(toolCallId) : undefined;
      if (!id) break;

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
