import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { debugWarn } from "@/utils/debug";

export function summarizeStreamForDebug(stream: unknown): string {
  if (!stream || typeof stream !== "object") {
    return `type=${typeof stream}`;
  }
  const record = stream as Record<PropertyKey, unknown>;
  const ctor = (stream as { constructor?: { name?: string } }).constructor
    ?.name;
  const controller =
    record.controller && typeof record.controller === "object"
      ? (record.controller as Record<string, unknown>)
      : null;
  const keys = Object.keys(record).slice(0, 8);
  return [
    `ctor=${ctor ?? "unknown"}`,
    `asyncIterator=${typeof record[Symbol.asyncIterator]}`,
    `controller=${typeof record.controller}`,
    `controllerAbort=${typeof controller?.abort}`,
    `controllerSignal=${typeof controller?.signal}`,
    keys.length > 0 ? `keys=${keys.join(",")}` : "keys=(none)",
  ].join(" ");
}

export function summarizeChunkForDebug(
  chunk: LettaStreamingResponse | null,
): string {
  if (!chunk) {
    return "none";
  }
  const record = chunk as unknown as Record<string, unknown>;
  const parts = [`message_type=${chunk.message_type ?? "unknown"}`];
  for (const key of ["run_id", "seq_id", "id", "otid", "tool_call_id"]) {
    const value = record[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      parts.push(`${key}=${value}`);
    }
  }
  if (chunk.message_type === "stop_reason") {
    parts.push(`stop_reason=${String(record.stop_reason ?? "unknown")}`);
  }
  const toolCalls = record.tool_calls;
  if (Array.isArray(toolCalls)) {
    parts.push(`tool_calls=${toolCalls.length}`);
  }
  return parts.join(" ");
}

export function abortStreamController(
  stream: Stream<LettaStreamingResponse>,
  reason: string,
): void {
  const controller = (stream as unknown as { controller?: unknown }).controller;
  if (!controller || typeof controller !== "object") {
    debugWarn(
      "drainStream",
      "stream.controller is unavailable during %s - cannot abort HTTP request (%s)",
      reason,
      summarizeStreamForDebug(stream),
    );
    return;
  }

  const controllerRecord = controller as {
    abort?: () => void;
    signal?: { aborted?: boolean };
  };
  if (controllerRecord.signal?.aborted) {
    return;
  }
  if (typeof controllerRecord.abort !== "function") {
    debugWarn(
      "drainStream",
      "stream.controller.abort is unavailable during %s - cannot abort HTTP request (%s)",
      reason,
      summarizeStreamForDebug(stream),
    );
    return;
  }

  controllerRecord.abort();
}
