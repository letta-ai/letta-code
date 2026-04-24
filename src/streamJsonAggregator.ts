/**
 * Aggregator for stream-json wire emission.
 *
 * The Letta server streams SDK chunks that are fragments of logical messages
 * — a single assistant_message or approval_request_message typically arrives
 * as many events with incremental `content` / `arguments` deltas. In
 * `--output-format stream-json` this used to result in one wire event per
 * fragment, so consumers saw dozens of tiny `{type:"message", ...}` lines
 * per turn, many with `arguments: null` or half-JSON strings.
 *
 * This module coalesces fragments into one wire event per logical message:
 *
 * - `assistant_message` / `reasoning_message` chunks with the same otid (or
 *   `id` if no otid) are merged on `content` / `reasoning` concatenation.
 * - `tool_call_message` / `approval_request_message` chunks with the same
 *   `tool_call.tool_call_id` are merged on `arguments` concatenation.
 * - `tool_return_message` is never fragmented by the server; it's emitted
 *   directly, and flushes the matching tool_call accumulator first.
 * - `stop_reason` and the following `usage_statistics` are *merged inline*
 *   onto the step's terminating message rather than emitted as separate
 *   wire events:
 *     - `end_turn` / `max_steps` / `max_tokens` / `stop_sequence` →
 *       attached to the last `assistant_message` (fallback `reasoning_message`)
 *     - `requires_approval` → attached to the `approval_request_message`
 *     - `error` or no clear target → emitted as standalone events (rare)
 *   The merged message carries `stop_reason: "<reason>"` and a nested
 *   `usage: { ... }` block matching the `result` line's usage shape.
 * - Unknown or non-accumulable chunks flush pending first, then pass through.
 *
 * When `passthrough: true` (i.e. `--include-partial-messages`), aggregation
 * is bypassed entirely and chunks are emitted one-to-one as `stream_event`
 * envelopes, exactly as the pre-aggregator code did.
 */

import { randomUUID } from "node:crypto";
import type {
  LettaStreamingResponse,
  ToolCall,
} from "@letta-ai/letta-client/resources/agents/messages";
import { writeWireMessage } from "./streamJsonWriter";
import type {
  MessageWire,
  StreamEvent,
  UsageStatistics,
} from "./types/protocol";

type ChunkWithIds = LettaStreamingResponse & {
  id?: string;
  otid?: string;
};

type TextKind = "assistant_message" | "reasoning_message";
type ToolCallKind = "tool_call_message" | "approval_request_message";

/**
 * Fields shared by every pending entry. The `stopReason` and `usage` slots
 * are populated when the step's terminator events arrive on the stream;
 * they're rendered inline on the merged wire emission at flush time.
 */
interface PendingTerminators {
  stopReason?: string;
  usage?: UsageStatistics;
}

interface PendingTextEntry extends PendingTerminators {
  kind: TextKind;
  key: string;
  uuid: string;
  // The accumulated chunk, with `content` / `reasoning` concatenated.
  // Stored as a LettaStreamingResponse so we can spread it into a MessageWire
  // at flush time, preserving all fields (id, otid, model, date, etc.).
  chunk: LettaStreamingResponse;
  // Concatenated text (for assistant: content; for reasoning: reasoning).
  text: string;
}

interface PendingToolCallEntry extends PendingTerminators {
  kind: ToolCallKind;
  key: string; // tool_call_id
  uuid: string;
  chunk: LettaStreamingResponse;
  toolName: string | undefined;
  args: string; // concatenated arguments JSON text
}

type PendingEntry = PendingTextEntry | PendingToolCallEntry;

export interface AggregatorOptions {
  sessionId: string;
  agentId: string;
  conversationId: string;
  /**
   * When true, bypass aggregation and emit each chunk as a `stream_event`
   * envelope (matching `--include-partial-messages` behavior).
   */
  passthrough: boolean;
}

export class StreamJsonAggregator {
  private readonly options: AggregatorOptions;
  // Single map keyed by `${kind}:${key}` so insertion order is preserved
  // across text and tool-call accumulators — flush emits them in the order
  // they first appeared on the stream.
  private readonly pending = new Map<string, PendingEntry>();

  constructor(options: AggregatorOptions) {
    this.options = options;
  }

  ingest(chunk: LettaStreamingResponse): void {
    if (this.options.passthrough) {
      this.emitStreamEvent(chunk);
      return;
    }

    const messageType = (chunk as { message_type?: string }).message_type;

    switch (messageType) {
      case "assistant_message":
      case "reasoning_message":
        this.accumulateText(messageType, chunk as ChunkWithIds);
        return;

      case "tool_call_message":
      case "approval_request_message":
        this.accumulateToolCall(messageType, chunk as ChunkWithIds);
        return;

      case "tool_return_message": {
        const toolCallId = (chunk as { tool_call_id?: string }).tool_call_id;
        if (toolCallId) this.flushToolCall(toolCallId);
        this.emitMessage(chunk);
        return;
      }

      case "stop_reason": {
        const stopReason = (chunk as { stop_reason?: string }).stop_reason;
        if (!stopReason) {
          // Malformed chunk — preserve ordering and pass through.
          this.flushPending();
          this.emitMessage(chunk);
          return;
        }
        const target = this.pickStopReasonTarget(stopReason);
        if (target) {
          // Attach inline; do NOT flush yet — we still want to merge the
          // following `usage_statistics` onto the same message.
          target.stopReason = stopReason;
        } else {
          // No clear target (e.g. error stop with no preceding content):
          // emit as a standalone event after flushing.
          this.flushPending();
          this.emitMessage(chunk);
        }
        return;
      }

      case "usage_statistics": {
        const target = this.findTargetWithStopReason();
        if (target) {
          target.usage = this.extractUsage(chunk);
          // `usage_statistics` is the last server event in a step, so it's
          // safe to flush all pending entries now (the step is closed).
          this.flushPending();
        } else {
          this.flushPending();
          this.emitMessage(chunk);
        }
        return;
      }

      default:
        // Unknown or non-accumulable chunk: flush pending so ordering is
        // preserved, then pass through.
        this.flushPending();
        this.emitMessage(chunk);
    }
  }

  /**
   * Emit all buffered text / tool-call accumulators in insertion order, then
   * clear them.
   *
   * Each entry is rendered with its accumulated text/args, and any merged
   * `stop_reason` / `usage` terminators inline on the wire message.
   *
   * Call this before emitting a non-chunk event (error, recovery,
   * auto_approval) from outside the aggregator, so the buffered chunks
   * appear on the wire before the out-of-band message.
   */
  flushPending(): void {
    if (this.pending.size === 0) return;
    for (const entry of this.pending.values()) {
      writeWireMessage(this.buildPendingWire(entry));
    }
    this.pending.clear();
  }

  /**
   * Flush all pending buffered events. Safety net for turn-end / abort paths.
   *
   * (Kept as a separate method from `flushPending` so callers can express
   * intent — "I'm done with this turn" vs "I'm interleaving an out-of-band
   * event" — even though both currently delegate to the same flush.)
   */
  flushAll(): void {
    this.flushPending();
  }

  // ─────────────────────────── internals ───────────────────────────

  private accumulateText(kind: TextKind, chunk: ChunkWithIds): void {
    const key = chunk.otid ?? chunk.id;
    if (!key) {
      // No correlatable key — pass through without merging.
      this.emitMessage(chunk);
      return;
    }

    const mapKey = `${kind}:${key}`;
    const existing = this.pending.get(mapKey);
    const delta = this.extractTextDelta(kind, chunk);

    if (existing && existing.kind === kind) {
      const merged: PendingTextEntry = {
        ...existing,
        text: existing.text + delta,
        chunk: this.mergeTextChunk(
          kind,
          existing.chunk,
          chunk,
          existing.text + delta,
        ),
      };
      this.pending.set(mapKey, merged);
      return;
    }

    // New entry.
    const uuid = chunk.otid ?? chunk.id ?? randomUUID();
    const entry: PendingTextEntry = {
      kind,
      key,
      uuid,
      chunk: this.mergeTextChunk(kind, undefined, chunk, delta),
      text: delta,
    };
    this.pending.set(mapKey, entry);
  }

  private accumulateToolCall(kind: ToolCallKind, chunk: ChunkWithIds): void {
    const toolCall = this.extractToolCall(chunk);
    if (!toolCall?.tool_call_id) {
      this.emitMessage(chunk);
      return;
    }

    const toolCallId = toolCall.tool_call_id;
    const mapKey = `${kind}:${toolCallId}`;
    const existing = this.pending.get(mapKey);
    const argsDelta = toolCall.arguments ?? "";
    const name = toolCall.name ?? undefined;

    if (existing && existing.kind === kind) {
      const mergedArgs = existing.args + argsDelta;
      // Prefer the first non-empty name seen. Backend sometimes streams
      // the tool's name on a later chunk after the initial args delta.
      const mergedName =
        existing.toolName && existing.toolName.length > 0
          ? existing.toolName
          : name;
      const merged: PendingToolCallEntry = {
        ...existing,
        toolName: mergedName,
        args: mergedArgs,
        chunk: this.mergeToolCallChunk(
          kind,
          existing.chunk,
          chunk,
          toolCallId,
          mergedName,
          mergedArgs,
        ),
      };
      this.pending.set(mapKey, merged);
      return;
    }

    const uuid = chunk.otid ?? chunk.id ?? toolCallId;
    const entry: PendingToolCallEntry = {
      kind,
      key: toolCallId,
      uuid,
      chunk: this.mergeToolCallChunk(
        kind,
        undefined,
        chunk,
        toolCallId,
        name,
        argsDelta,
      ),
      toolName: name,
      args: argsDelta,
    };
    this.pending.set(mapKey, entry);
  }

  private flushToolCall(toolCallId: string): void {
    const approvalKey = `approval_request_message:${toolCallId}`;
    const toolCallKey = `tool_call_message:${toolCallId}`;
    for (const k of [approvalKey, toolCallKey]) {
      const entry = this.pending.get(k);
      if (entry) {
        writeWireMessage(this.buildPendingWire(entry));
        this.pending.delete(k);
      }
    }
  }

  /**
   * Pick the pending entry that a `stop_reason` belongs to, based on the
   * stop reason value:
   *   - `requires_approval` → the approval_request_message in the step
   *     (fallback: tool_call_message)
   *   - any other natural stop (`end_turn`, `max_steps`, `max_tokens`,
   *     `stop_sequence`, ...) → the last assistant_message
   *     (fallback: last reasoning_message)
   *   - `error` and other unknown reasons → undefined (caller emits standalone)
   */
  private pickStopReasonTarget(reason: string): PendingEntry | undefined {
    const entries = Array.from(this.pending.values());
    if (entries.length === 0) return undefined;

    if (reason === "requires_approval") {
      // Walk the entries newest-first to pick the most recent matching one.
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (
          e &&
          (e.kind === "approval_request_message" ||
            e.kind === "tool_call_message")
        ) {
          return e;
        }
      }
      return undefined;
    }

    if (reason === "error") {
      // Errors don't have a clean content target — emit standalone.
      return undefined;
    }

    // Default natural-stop behavior: last assistant, fallback last reasoning.
    let assistant: PendingEntry | undefined;
    let reasoning: PendingEntry | undefined;
    for (const e of entries) {
      if (e.kind === "assistant_message") assistant = e;
      else if (e.kind === "reasoning_message") reasoning = e;
    }
    return assistant ?? reasoning;
  }

  /**
   * Locate the pending entry that already has a `stopReason` attached so
   * we can merge the following `usage_statistics` onto the same message.
   */
  private findTargetWithStopReason(): PendingEntry | undefined {
    for (const e of this.pending.values()) {
      if (e.stopReason) return e;
    }
    return undefined;
  }

  private extractUsage(chunk: LettaStreamingResponse): UsageStatistics {
    const c = chunk as Record<string, unknown>;
    return {
      prompt_tokens: (c.prompt_tokens as number) ?? 0,
      completion_tokens: (c.completion_tokens as number) ?? 0,
      total_tokens: (c.total_tokens as number) ?? 0,
      step_count: (c.step_count as number) ?? 0,
      cached_input_tokens: (c.cached_input_tokens as number | null) ?? null,
      cache_write_tokens: (c.cache_write_tokens as number | null) ?? null,
      reasoning_tokens: (c.reasoning_tokens as number | null) ?? null,
      context_tokens: (c.context_tokens as number | null) ?? null,
    } as UsageStatistics;
  }

  private emitMessage(chunk: LettaStreamingResponse): void {
    writeWireMessage(this.buildMessageWire(chunk));
  }

  private emitStreamEvent(chunk: LettaStreamingResponse): void {
    const chunkWithIds = chunk as ChunkWithIds;
    const uuid = chunkWithIds.otid ?? chunkWithIds.id ?? randomUUID();
    const env: StreamEvent = {
      type: "stream_event",
      event: chunk,
      session_id: this.options.sessionId,
      agent_id: this.options.agentId,
      conversation_id: this.options.conversationId,
      uuid,
    };
    writeWireMessage(env);
  }

  private buildMessageWire(
    chunk: LettaStreamingResponse,
    explicitUuid?: string,
  ): MessageWire {
    const chunkWithIds = chunk as ChunkWithIds;
    const uuid =
      explicitUuid ?? chunkWithIds.otid ?? chunkWithIds.id ?? randomUUID();
    return {
      type: "message",
      ...chunk,
      session_id: this.options.sessionId,
      agent_id: this.options.agentId,
      conversation_id: this.options.conversationId,
      uuid,
    } as MessageWire;
  }

  /**
   * Render a pending entry as a wire message, inlining any merged
   * `stop_reason` / `usage` terminators alongside the accumulated chunk.
   */
  private buildPendingWire(entry: PendingEntry): MessageWire {
    const base = this.buildMessageWire(entry.chunk, entry.uuid) as MessageWire &
      Record<string, unknown>;
    if (entry.stopReason) base.stop_reason = entry.stopReason;
    if (entry.usage) base.usage = entry.usage;
    return base as MessageWire;
  }

  private extractTextDelta(
    kind: TextKind,
    chunk: LettaStreamingResponse,
  ): string {
    if (kind === "reasoning_message") {
      const r = (chunk as { reasoning?: string }).reasoning;
      return typeof r === "string" ? r : "";
    }
    // assistant_message: content may be a string (streaming delta) or an
    // array of content parts; extract text either way.
    const content = (chunk as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .join("");
    }
    return "";
  }

  private mergeTextChunk(
    kind: TextKind,
    prior: LettaStreamingResponse | undefined,
    incoming: LettaStreamingResponse,
    mergedText: string,
  ): LettaStreamingResponse {
    // Start from the latest chunk to carry its latest metadata (id, otid,
    // date, etc.), overwriting the content field with the merged text.
    const base = prior ? { ...prior, ...incoming } : { ...incoming };
    if (kind === "reasoning_message") {
      return { ...base, reasoning: mergedText } as LettaStreamingResponse;
    }
    return { ...base, content: mergedText } as LettaStreamingResponse;
  }

  private extractToolCall(chunk: LettaStreamingResponse): ToolCall | undefined {
    const withToolCall = chunk as {
      tool_call?: ToolCall;
      tool_calls?: ToolCall[];
    };
    if (withToolCall.tool_call) return withToolCall.tool_call;
    if (
      Array.isArray(withToolCall.tool_calls) &&
      withToolCall.tool_calls.length > 0
    ) {
      return withToolCall.tool_calls[0];
    }
    return undefined;
  }

  private mergeToolCallChunk(
    kind: ToolCallKind,
    prior: LettaStreamingResponse | undefined,
    incoming: LettaStreamingResponse,
    toolCallId: string,
    toolName: string | undefined,
    mergedArgs: string,
  ): LettaStreamingResponse {
    const base = prior ? { ...prior, ...incoming } : { ...incoming };
    const mergedToolCall = {
      tool_call_id: toolCallId,
      name: toolName ?? "",
      arguments: mergedArgs,
    };
    // Normalize to `tool_call` field; some server paths use `tool_calls[]`.
    // Consumers of the merged output should find the complete info in either
    // field. We clear the array form to avoid stale partial entries.
    void kind;
    return {
      ...base,
      tool_call: mergedToolCall,
      tool_calls: [mergedToolCall],
    } as LettaStreamingResponse;
  }
}
