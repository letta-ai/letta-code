/**
 * Tool lifecycle exposure for the OpenAI Responses API handler.
 *
 * The app-server's native WS stream emits `stream_delta` messages whose
 * `delta` payloads are `StreamDelta` values (see `@/types/protocol_v2`).
 * When the delta is a `MessageDelta` — i.e. a `LettaStreamingResponse`
 * chunk — it may carry `tool_call_message`, `approval_request_message`,
 * or `tool_return_message` payloads that describe the full lifecycle of a
 * tool call:
 *
 *   1. `tool_call_message` / `approval_request_message` — the LLM requests
 *      a tool call. Arguments may arrive in fragments (partial JSON via
 *      `ToolCallDelta`), so multiple messages can share the same
 *      `tool_call_id`.
 *   2. `tool_return_message` — server-side tools emit a terminal result;
 *      client-side tools may emit repeated output snapshots before their
 *      `client_tool_end` and canonical final return. Results may be singular
 *      (`tool_call_id` + `status` + `tool_return`) or plural
 *      (`tool_returns: ToolReturn[]`).
 *
 * This module aggregates those fragments and exposes a typed callback
 * surface so an HTTP Responses handler can observe:
 *
 *   - **start** — emitted once per `tool_call_id` when the first
 *     `tool_call_message` or `approval_request_message` for that id
 *     arrives.
 *   - **arguments_delta** — emitted for each incremental arguments
 *     fragment (including the first message if it already carries
 *     arguments).
 *   - **complete** — emitted once per `tool_call_id` from the authoritative
 *     terminal return, carrying the final accumulated arguments, output, and
 *     success/error status. Client-side progress snapshots remain nonterminal.
 *
 * Events after an authoritative terminal result are suppressed, and a
 * `tool_call_message` that arrives after completion is ignored.
 *
 * The module is transport-agnostic: it accepts already-decoded
 * `StreamDelta` values and does not touch sockets. This keeps it
 * testable without WS infrastructure and compatible with both the
 * chat-completions and Responses-API surfaces.
 */

import type { StreamDelta } from "@/types/protocol_v2";

// ─────────────────────────────────────────────────────────────────────────
// Event types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Emitted once per `tool_call_id` when the first `tool_call_message` or
 * `approval_request_message` for that call arrives. Carries the tool
 * name if it was already present in the first fragment.
 */
export interface ToolCallStartEvent {
  type: "tool_call_start";
  tool_call_id: string;
  tool_name: string | null;
}

/**
 * Emitted for each incremental arguments fragment. The `arguments_delta`
 * is the raw string fragment as it appeared on the wire (may be partial
 * JSON). Concatenating all deltas for a `tool_call_id` yields the full
 * arguments string.
 */
export interface ToolCallArgumentsDeltaEvent {
  type: "tool_call_arguments_delta";
  tool_call_id: string;
  arguments_delta: string;
}

/**
 * Emitted once per `tool_call_id` when the matching `tool_return_message`
 * arrives. Carries the final accumulated arguments, the tool output
 * (stringified if multimodal), and whether the tool succeeded or erred.
 */
export interface ToolCallCompleteEvent {
  type: "tool_call_complete";
  tool_call_id: string;
  tool_name: string | null;
  arguments: string;
  output: string;
  success: boolean;
}

/**
 * Union of all tool lifecycle events.
 */
export type ToolCallEvent =
  | ToolCallStartEvent
  | ToolCallArgumentsDeltaEvent
  | ToolCallCompleteEvent;

/**
 * Callback invoked for every tool lifecycle event.
 */
export type ToolLifecycleCallback = (event: ToolCallEvent) => void;

// ─────────────────────────────────────────────────────────────────────────
// Internal tracking state
// ─────────────────────────────────────────────────────────────────────────

interface ToolCallState {
  toolCallId: string;
  name: string | null;
  arguments: string;
  started: boolean;
  completed: boolean;
  clientManaged: boolean;
  terminalStatus: "success" | "error" | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Wire-shape helpers (operate on plain records, no Letta client dep)
// ─────────────────────────────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Extract tool-call fragments from a `tool_call_message` or
 * `approval_request_message` wire record. Handles both the deprecated
 * singular `tool_call` field and the `tool_calls` array, and supports
 * `ToolCallDelta` (partial) payloads where `name` or `arguments` may be
 * absent/null.
 *
 * Mirrors the extraction logic in `channel-rich-draft-streamer.ts` so
 * both consumers agree on how to read the wire format.
 */
function extractToolCallFragments(record: UnknownRecord | null): Array<{
  toolCallId: string;
  name: string | null;
  argumentsDelta: string | null;
}> {
  if (!record) {
    return [];
  }

  const rawToolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : record.tool_call
      ? [record.tool_call]
      : [];

  const fragments: Array<{
    toolCallId: string;
    name: string | null;
    argumentsDelta: string | null;
  }> = [];

  for (const rawToolCall of rawToolCalls) {
    const toolCall = asRecord(rawToolCall);
    if (!toolCall) {
      continue;
    }
    const toolCallId = stringValue(toolCall.tool_call_id);
    if (!toolCallId) {
      continue;
    }
    const name = stringValue(toolCall.name) ?? null;
    const argumentsDelta = stringValue(toolCall.arguments) ?? null;
    fragments.push({ toolCallId, name, argumentsDelta });
  }

  return fragments;
}

/**
 * Normalise a `tool_return` value to a display string. Accepts plain
 * strings, arrays of `{ type: "text", text: string }` content parts,
 * and arbitrary objects (JSON-stringified as a fallback).
 */
function normalizeToolReturnOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const textParts = value
      .filter(
        (part: unknown): part is { type: string; text: string } =>
          part !== null &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type: unknown }).type === "text" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string",
      )
      .map((part) => part.text);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type: unknown }).type === "text" &&
    "text" in value &&
    typeof (value as { text: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Extract canonical tool returns from a `tool_return_message` wire record.
 * Handles both the plural `tool_returns` array and the deprecated
 * singular `tool_call_id` / `status` / `tool_return` fields.
 *
 * Mirrors `extractCanonicalToolReturnsFromWire` in `interrupts.ts`.
 */
function extractToolReturns(record: UnknownRecord | null): Array<{
  toolCallId: string;
  status: "success" | "error";
  output: string;
}> {
  if (!record) {
    return [];
  }

  const results: Array<{
    toolCallId: string;
    status: "success" | "error";
    output: string;
  }> = [];

  // Plural form: tool_returns array
  const toolReturnsValue = record.tool_returns;
  if (Array.isArray(toolReturnsValue)) {
    for (const raw of toolReturnsValue) {
      const rec = asRecord(raw);
      if (!rec) {
        continue;
      }
      const toolCallId = stringValue(rec.tool_call_id);
      const status = asToolReturnStatus(rec.status);
      if (!toolCallId || !status) {
        continue;
      }
      results.push({
        toolCallId,
        status,
        output: normalizeToolReturnOutput(rec.tool_return),
      });
    }
    if (results.length > 0) {
      return results;
    }
  }

  // Singular form: top-level tool_call_id + status + tool_return
  const topLevelToolCallId = stringValue(record.tool_call_id);
  const topLevelStatus = asToolReturnStatus(record.status);
  if (!topLevelToolCallId || !topLevelStatus) {
    return [];
  }
  return [
    {
      toolCallId: topLevelToolCallId,
      status: topLevelStatus,
      output: normalizeToolReturnOutput(record.tool_return),
    },
  ];
}

function asToolReturnStatus(value: unknown): "success" | "error" | null {
  if (value === "success" || value === "error") {
    return value;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Tool lifecycle tracker
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stateful tracker that aggregates partial tool-call and tool-return
 * messages and emits structured lifecycle events via a callback.
 *
 * Create one tracker per turn (or per stream) and feed it every
 * `StreamDelta` via {@link ToolLifecycleTracker.process}. The tracker
 * is single-use: once {@link ToolLifecycleTracker.dispose} is called it
 * stops emitting.
 */
export interface ToolLifecycleTracker {
  /**
   * Inspect a single `StreamDelta` and emit zero or more lifecycle
   * events. Only `MessageDelta` payloads whose `message_type` is
   * `tool_call_message`, `approval_request_message`, or
   * `tool_return_message` are processed; all other deltas are ignored.
   */
  process(delta: StreamDelta): void;

  /** Complete every started call without a return as failed. */
  failPending(output: string): void;

  /**
   * Release all internal state. After calling this, `process` becomes
   * a no-op.
   */
  dispose(): void;
}

/**
 * Create a {@link ToolLifecycleTracker} that emits events through the
 * provided callback.
 *
 * @param onEvent - Callback invoked for each lifecycle event.
 */
export function createToolLifecycleTracker(
  onEvent: ToolLifecycleCallback,
): ToolLifecycleTracker {
  const calls = new Map<string, ToolCallState>();
  const completedIds = new Set<string>();
  let disposed = false;

  function getOrCreate(toolCallId: string): ToolCallState {
    const existing = calls.get(toolCallId);
    if (existing) {
      return existing;
    }
    const state: ToolCallState = {
      toolCallId,
      name: null,
      arguments: "",
      started: false,
      completed: false,
      clientManaged: false,
      terminalStatus: null,
    };
    calls.set(toolCallId, state);
    return state;
  }

  function handleToolCallFragment(
    toolCallId: string,
    name: string | null,
    argumentsDelta: string | null,
  ): void {
    if (completedIds.has(toolCallId)) {
      return;
    }
    const state = getOrCreate(toolCallId);

    // Emit start once per tool_call_id.
    if (!state.started) {
      state.started = true;
      if (name) {
        state.name = name;
      }
      onEvent({
        type: "tool_call_start",
        tool_call_id: toolCallId,
        tool_name: state.name,
      });
    } else if (name && !state.name) {
      // A later fragment may carry the name if the first one didn't.
      state.name = name;
    }

    // Emit arguments delta if present (non-null, including empty string).
    if (argumentsDelta !== null) {
      state.arguments += argumentsDelta;
      onEvent({
        type: "tool_call_arguments_delta",
        tool_call_id: toolCallId,
        arguments_delta: argumentsDelta,
      });
    }
  }

  function handleToolReturn(
    toolCallId: string,
    status: "success" | "error",
    output: string,
  ): void {
    if (completedIds.has(toolCallId)) {
      return;
    }
    completedIds.add(toolCallId);

    const state = getOrCreate(toolCallId);
    state.completed = true;

    onEvent({
      type: "tool_call_complete",
      tool_call_id: toolCallId,
      tool_name: state.name,
      arguments: state.arguments,
      output,
      success: status === "success",
    });
  }

  function process(delta: StreamDelta): void {
    if (disposed) {
      return;
    }

    const record = delta as unknown as UnknownRecord;
    const messageType = stringValue(record.message_type);
    const toolCallId = stringValue(record.tool_call_id);

    // Client-executed tools emit repeated tool_return_message snapshots while
    // running. The client_tool_end followed by the canonical final return is
    // the terminal edge; treating the first snapshot as terminal truncates
    // output and can hide a later failure.
    if (messageType === "client_tool_start" && toolCallId) {
      const state = getOrCreate(toolCallId);
      state.clientManaged = true;
      if (!state.name) state.name = stringValue(record.tool_name) ?? null;
      return;
    }
    if (messageType === "client_tool_end" && toolCallId) {
      const state = getOrCreate(toolCallId);
      state.clientManaged = true;
      state.terminalStatus = asToolReturnStatus(record.status);
      return;
    }

    // Only MessageDelta payloads carry tool_call/tool_return messages.
    if ((delta as { type?: unknown }).type !== "message") {
      return;
    }

    if (
      messageType === "tool_call_message" ||
      messageType === "approval_request_message"
    ) {
      for (const fragment of extractToolCallFragments(record)) {
        handleToolCallFragment(
          fragment.toolCallId,
          fragment.name,
          fragment.argumentsDelta,
        );
      }
      return;
    }

    if (messageType === "tool_return_message") {
      for (const result of extractToolReturns(record)) {
        const state = getOrCreate(result.toolCallId);
        if (!state.clientManaged) {
          handleToolReturn(result.toolCallId, result.status, result.output);
          continue;
        }
        if (state.terminalStatus) {
          handleToolReturn(
            result.toolCallId,
            state.terminalStatus,
            result.output,
          );
        }
      }
      return;
    }
  }

  function dispose(): void {
    disposed = true;
    calls.clear();
    completedIds.clear();
  }

  function failPending(output: string): void {
    if (disposed) return;
    for (const state of calls.values()) {
      if (!state.completed) {
        handleToolReturn(state.toolCallId, "error", output);
      }
    }
  }

  return { process, failPending, dispose };
}

/**
 * Convenience wrapper: process an array of `StreamDelta` values through
 * a fresh tracker, collecting all emitted events into an array. Useful
 * for testing and one-shot batch processing.
 */
export function collectToolLifecycleEvents(
  deltas: Iterable<StreamDelta>,
): ToolCallEvent[] {
  const events: ToolCallEvent[] = [];
  const tracker = createToolLifecycleTracker((event) => {
    events.push(event);
  });
  for (const delta of deltas) {
    tracker.process(delta);
  }
  tracker.dispose();
  return events;
}
