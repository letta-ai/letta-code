// Structural types keep this module free of an import cycle with accumulator.
interface AssistantLine {
  kind: "assistant";
  id: string;
  text: string;
  phase: "streaming" | "finished";
  isContinuation?: boolean;
  messageId?: string;
}

interface AssistantLineBuffers {
  byId: Map<string, { kind: string } | AssistantLine>;
  order: string[];
  splitCounters: Map<string, number>;
  assistantCanonicalByOtid: Map<string, string>;
  assistantCanonicalByMessageId: Map<string, string>;
  lastOtid: string | null;
}

interface AssistantLineKeys {
  id: string;
  otid: string | undefined;
  messageId: string | undefined;
}

/**
 * Return the line that should receive the next assistant text delta.
 *
 * Providers that interleave reasoning deltas inside a reply finish the text
 * line mid-sentence, and a finished line may already be committed to the
 * static transcript, which never re-renders. When more text arrives for a
 * finished line, stream it into a new continuation line so it stays visible.
 */
export function ensureAssistantStreamLine(
  b: AssistantLineBuffers,
  keys: AssistantLineKeys,
  hasDelta: boolean,
): { id: string; line: AssistantLine } {
  const existing = b.byId.get(keys.id);
  if (existing && isAssistantLine(existing)) {
    if (!hasDelta || existing.phase !== "finished") {
      return { id: keys.id, line: existing };
    }
    return startContinuation(b, keys);
  }
  const line: AssistantLine = {
    kind: "assistant",
    id: keys.id,
    text: "",
    phase: "streaming",
    messageId: keys.messageId,
  };
  b.byId.set(keys.id, line);
  b.order.push(keys.id);
  return { id: keys.id, line };
}

function startContinuation(
  b: AssistantLineBuffers,
  keys: AssistantLineKeys,
): { id: string; line: AssistantLine } {
  const counter = b.splitCounters.get(keys.id) ?? 0;
  b.splitCounters.set(keys.id, counter + 1);
  const id = `${keys.id}-cont-${counter}`;
  const line: AssistantLine = {
    kind: "assistant",
    id,
    text: "",
    phase: "streaming",
    isContinuation: true,
    messageId: keys.messageId,
  };
  b.byId.set(id, line);
  b.order.push(id);
  if (keys.otid) b.assistantCanonicalByOtid.set(keys.otid, id);
  if (keys.messageId) b.assistantCanonicalByMessageId.set(keys.messageId, id);
  b.lastOtid = id;
  return { id, line };
}

function isAssistantLine(
  line: { kind: string } | AssistantLine,
): line is AssistantLine {
  return line.kind === "assistant";
}
