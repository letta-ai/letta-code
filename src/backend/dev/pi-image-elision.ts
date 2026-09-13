import type { LocalMessage } from "@/backend/local/local-message";
import type { ProviderTurnInput } from "./provider-turn-executor";
import { estimateProviderRequestBytes } from "./provider-turn-executor";

// Classifier threshold for oversized request payloads. This is a transport
// limit, not a token limit: providers accept image-heavy requests whose
// semantic token cost is small, but large raw bodies cause generic transport
// failures (connection errors, SSE header timeouts) instead of clean,
// classifiable overflow errors. When a retryable transport error occurs and
// the serialized payload exceeds this threshold, we treat it as context
// overflow (compact + retry) instead of retrying the same oversized payload.
// It never blocks a request preemptively. Empirically (local-conv-48): ~7MB
// of in-context images still succeeded against Anthropic at ~400k context
// tokens, while ~11.8MB failed with "Connection error." on every provider.
// 8MB keeps headroom under Anthropic's documented 32MB cap while staying
// above known-good payloads. Local networks can fail below that threshold, so
// LETTA_LOCAL_REQUEST_BYTE_LIMIT can lower the reactive classifier in dev.
const DEFAULT_LOCAL_PROVIDER_REQUEST_BYTE_LIMIT = 8_000_000;
const LOCAL_PROVIDER_REQUEST_BYTE_LIMIT_ENV = "LETTA_LOCAL_REQUEST_BYTE_LIMIT";

function localProviderRequestByteLimit(): number {
  const raw = process.env[LOCAL_PROVIDER_REQUEST_BYTE_LIMIT_ENV];
  if (!raw) return DEFAULT_LOCAL_PROVIDER_REQUEST_BYTE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOCAL_PROVIDER_REQUEST_BYTE_LIMIT;
  }
  return Math.floor(parsed);
}

function localProviderRequestByteTarget(
  limit = localProviderRequestByteLimit(),
) {
  return Math.floor(limit * 0.75);
}

// Letta Code addition with no Pi analog. Pi compacts reactively on clean,
// classifiable provider overflow errors (`isContextOverflow`, including
// Anthropic 413 `request_too_large`). But oversized payloads frequently kill
// the transport from a local device before any classifiable response arrives
// ("Connection error.", SSE header timeouts), which the retry classifier
// treats as transient — retrying the same oversized payload forever. Pi has
// the same gap (earendil-works/pi #2810, #4642, #5369: "permanently bricking
// sessions"). When a retryable transport failure occurs and the payload is
// measurably oversized, classify it as context overflow so it enters the same
// compaction path instead of the retry loop. This only ever runs after a real
// provider failure; it never preemptively blocks a request.
export function isOversizedPayloadTransportFailure(
  input: ProviderTurnInput,
): boolean {
  const requestBytes = estimateProviderRequestBytes(input);
  const requestByteLimit = localProviderRequestByteLimit();
  return requestBytes !== undefined && requestBytes > requestByteLimit;
}

interface ImageElisionCandidate {
  messageIndex: number;
  blockIndex: number;
  mimeType?: string;
  bytes: number;
}

export interface ImagePayloadElision {
  input: ProviderTurnInput;
  beforeBytes: number;
  afterBytes: number;
  requestByteLimit: number;
  requestByteTarget: number;
  elidedImages: number;
  elidedBytes: number;
}

function imagePayloadBytes(data: unknown): number {
  return typeof data === "string" ? data.length : 0;
}

function imageElisionPlaceholder(mimeType: string | undefined, bytes: number) {
  const mb = (bytes / 1_000_000).toFixed(1);
  return `[Image omitted from this provider retry to reduce local request size: ${
    mimeType ?? "image"
  }, ~${mb}MB. The original image remains stored in conversation history.]`;
}

function imageElisionCandidates(
  messages: readonly LocalMessage[],
): ImageElisionCandidate[] {
  const candidates: ImageElisionCandidate[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "user" && message.role !== "toolResult") return;
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.type !== "image") return;
      const bytes = imagePayloadBytes(block.data);
      if (bytes <= 0) return;
      candidates.push({
        messageIndex,
        blockIndex,
        mimeType: block.mimeType,
        bytes,
      });
    });
  });
  // Prefer removing older images first; within a single message, remove larger
  // blobs first. If the request is still too large, this naturally proceeds to
  // newer images as needed.
  return candidates.sort(
    (a, b) =>
      a.messageIndex - b.messageIndex ||
      b.bytes - a.bytes ||
      a.blockIndex - b.blockIndex,
  );
}

function elideImagePayload(
  messages: readonly LocalMessage[],
  candidate: ImageElisionCandidate,
): LocalMessage[] {
  const message = messages[candidate.messageIndex];
  if (!message) return [...messages];
  if (message.role !== "user" && message.role !== "toolResult") {
    return [...messages];
  }
  if (!Array.isArray(message.content)) return [...messages];
  const block = message.content[candidate.blockIndex];
  if (block?.type !== "image") return [...messages];

  const content = [...message.content];
  content[candidate.blockIndex] = {
    type: "text",
    text: imageElisionPlaceholder(candidate.mimeType, candidate.bytes),
  };
  const next = [...messages];
  next[candidate.messageIndex] = { ...message, content } as LocalMessage;
  return next;
}

export function elideImagePayloadsForProviderRetry(
  input: ProviderTurnInput,
  options: { allowUnderLimit?: boolean } = {},
): ImagePayloadElision | null {
  const beforeBytes = estimateProviderRequestBytes(input);
  const requestByteLimit = localProviderRequestByteLimit();
  if (
    beforeBytes === undefined ||
    (!options.allowUnderLimit && beforeBytes <= requestByteLimit)
  ) {
    return null;
  }
  const requestByteTarget = options.allowUnderLimit
    ? Math.min(
        localProviderRequestByteTarget(requestByteLimit),
        Math.floor(beforeBytes * 0.75),
      )
    : localProviderRequestByteTarget(requestByteLimit);

  const candidates = imageElisionCandidates(input.uiMessages);
  if (candidates.length === 0) return null;

  let uiMessages = input.uiMessages;
  let afterBytes = beforeBytes;
  let elidedImages = 0;
  let elidedBytes = 0;
  for (const candidate of candidates) {
    if (afterBytes <= requestByteTarget) break;
    uiMessages = elideImagePayload(uiMessages, candidate);
    elidedImages += 1;
    elidedBytes += candidate.bytes;
    afterBytes =
      estimateProviderRequestBytes({ ...input, uiMessages }) ?? afterBytes;
  }

  if (elidedImages === 0 || afterBytes >= beforeBytes) return null;
  return {
    input: { ...input, uiMessages },
    beforeBytes,
    afterBytes,
    requestByteLimit,
    requestByteTarget,
    elidedImages,
    elidedBytes,
  };
}
