import { debugLog } from "@/utils/debug";

type TextKind = "assistant" | "reasoning";

interface TextIdentityBuffers {
  byId: ReadonlyMap<string, { kind: string; phase?: string }>;
  assistantCanonicalByMessageId: Map<string, string>;
  assistantCanonicalByOtid: Map<string, string>;
  reasoningCanonicalByMessageId: Map<string, string>;
  reasoningCanonicalByOtid: Map<string, string>;
}

/** Resolve mixed id/otid chunks without conflating distinct content blocks. */
export function resolveTextLineId(
  buffers: TextIdentityBuffers,
  chunk: { id?: string; otid?: string },
  kind: TextKind,
): string | undefined {
  const byMessageId =
    kind === "assistant"
      ? buffers.assistantCanonicalByMessageId
      : buffers.reasoningCanonicalByMessageId;
  const byOtid =
    kind === "assistant"
      ? buffers.assistantCanonicalByOtid
      : buffers.reasoningCanonicalByOtid;
  const messageId = typeof chunk.id === "string" ? chunk.id : undefined;
  const otid = typeof chunk.otid === "string" ? chunk.otid : undefined;
  const fromMessageId = messageId ? byMessageId.get(messageId) : undefined;
  const fromOtid = otid ? byOtid.get(otid) : undefined;

  let canonical = fromMessageId || fromOtid || messageId || otid;
  if (!canonical) return undefined;

  if (otid && !fromOtid && fromMessageId) {
    const existing = buffers.byId.get(fromMessageId);
    const hasOtherOtid = [...byOtid].some(
      ([alias, lineId]) => alias !== otid && lineId === fromMessageId,
    );
    if (
      existing?.kind === kind &&
      (existing.phase === "finished" || hasOtherOtid)
    ) {
      canonical = otid;
    }
  }

  // Preserve the existing mixed-id reconciliation: prefer the alias that
  // already has a line, falling back to the canonical backend message id.
  if (fromMessageId && fromOtid && fromMessageId !== fromOtid) {
    canonical =
      buffers.byId.has(fromOtid) && !buffers.byId.has(fromMessageId)
        ? fromOtid
        : fromMessageId;
    debugLog(
      "accumulator",
      `${kind} id/otid alias conflict resolved to ${canonical}`,
    );
  }

  // Some providers reuse the same id/otid for reasoning and assistant text.
  const existing = buffers.byId.get(canonical);
  if (existing && existing.kind !== kind) canonical = `${kind}:${canonical}`;

  if (messageId) byMessageId.set(messageId, canonical);
  if (otid) byOtid.set(otid, canonical);
  return canonical;
}
