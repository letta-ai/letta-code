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
 * - `stop_reason: requires_approval` + the following `usage_statistics` are
 *   *held* (buffered) so that `tool_return_message` events can be emitted
 *   before them — matching the logical step boundary. The caller releases
 *   them via `releaseHeldTerminators()` after local tool execution.
 * - `stop_reason` with any other value (e.g. `end_turn`) flushes pending and
 *   emits immediately.
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
import type { MessageWire, StreamEvent, WireMessage } from "./types/protocol";

type ChunkWithIds = LettaStreamingResponse & {
  id?: string;
  otid?: string;
};

type TextKind = "assistant_message" | "reasoning_message";
type ToolCallKind = "tool_call_message" | "approval_request_message";

interface PendingTextEntry {
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

interface PendingToolCallEntry {
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
  // Buffered `stop_reason: requires_approval` + subsequent `usage_statistics`.
  // Released by `releaseHeldTerminators()` after local tool execution.
  private readonly heldTerminators: WireMessage[] = [];

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
        this.flushPending();
        const stopReason = (chunk as { stop_reason?: string }).stop_reason;
        if (stopReason === "requires_approval") {
          this.heldTerminators.push(this.buildMessageWire(chunk));
        } else {
          this.emitMessage(chunk);
        }
        return;
      }

      case "usage_statistics": {
        // If we're holding step terminators (requires_approval path), this
        // usage_statistics belongs to that step — hold it too.
        if (this.heldTerminators.length > 0) {
          this.heldTerminators.push(this.buildMessageWire(chunk));
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
   * Emit any held `stop_reason` / `usage_statistics` events. Called by the
   * caller after local tool execution (executeApprovalBatch) completes, so
   * that `tool_return_message` events land *before* the step terminators.
   */
  releaseHeldTerminators(): void {
    if (this.heldTerminators.length === 0) return;
    for (const msg of this.heldTerminators) {
      writeWireMessage(msg);
    }
    this.heldTerminators.length = 0;
  }

  /**
   * Flush all pending buffered events. Safety net for turn-end / abort paths
   * where `releaseHeldTerminators` may not have been called explicitly.
   */
  flushAll(): void {
    this.flushPending();
    this.releaseHeldTerminators();
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

  private flushPending(): void {
    if (this.pending.size === 0) return;
    for (const entry of this.pending.values()) {
      const wire = this.buildMessageWire(entry.chunk, entry.uuid);
      writeWireMessage(wire);
    }
    this.pending.clear();
  }

  private flushToolCall(toolCallId: string): void {
    const approvalKey = `approval_request_message:${toolCallId}`;
    const toolCallKey = `tool_call_message:${toolCallId}`;
    for (const k of [approvalKey, toolCallKey]) {
      const entry = this.pending.get(k);
      if (entry) {
        writeWireMessage(this.buildMessageWire(entry.chunk, entry.uuid));
        this.pending.delete(k);
      }
    }
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
