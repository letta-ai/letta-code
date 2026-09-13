import type { ChannelTurnProgressUpdate } from "./types";

export interface LettaStreamErrorParams {
  errorType?: string;
  message: string;
  detail?: string;
  runId?: string;
}

export interface CollectLettaSseAssistantTextResult {
  text: string;
  chunkCount: number;
  stopReason?: string;
}

export interface CollectLettaSseAssistantTextOptions {
  onDelta?: (delta: unknown) => void | Promise<void>;
  onProgressUpdate?: (
    update: ChannelTurnProgressUpdate,
  ) => void | Promise<void>;
  progressBuilder?: {
    buildUpdates(delta: unknown): ChannelTurnProgressUpdate[];
  };
}

export interface FormatLettaStreamCoreErrorOptions {
  includeDetail?: boolean;
}

interface LettaSseTextContentPart {
  type: "text";
  text: string;
  signature?: string;
}

interface LettaSseAssistantMessage {
  message_type: "assistant_message";
  content?: string | LettaSseTextContentPart[];
}

interface LettaSseErrorMessage {
  message_type: "error_message";
  error_type?: string;
  message?: string;
  detail?: string;
  run_id?: string;
}

interface LettaSseStopReasonMessage {
  message_type: "stop_reason";
  stop_reason?: string;
}

export const LETTA_STREAM_NO_ASSISTANT_MESSAGE_ERROR =
  "No assistant message received in stream";

export class LettaStreamCoreError extends Error {
  readonly errorType?: string;
  readonly detail?: string;
  readonly runId?: string;

  constructor(params: LettaStreamErrorParams) {
    super(params.message);
    this.name = "LettaStreamCoreError";
    this.errorType = params.errorType;
    this.detail = params.detail;
    this.runId = params.runId;
  }
}

export class LettaStreamNoAssistantMessageError extends Error {
  constructor() {
    super(LETTA_STREAM_NO_ASSISTANT_MESSAGE_ERROR);
    this.name = "LettaStreamNoAssistantMessageError";
  }
}

function normalizeErrorLine(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function formatLettaStreamCoreErrorForChannel(
  error: LettaStreamCoreError,
  options: FormatLettaStreamCoreErrorOptions = {},
): string {
  const message =
    normalizeErrorLine(error.message) ?? "Core failed to generate a response.";
  const detail = normalizeErrorLine(error.detail);

  if (options.includeDetail === false || !detail || detail === message) {
    return message;
  }

  return `${message}\n${detail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isOptionalString(value: unknown): value is string | undefined {
  return typeof value === "undefined" || typeof value === "string";
}

function isLettaSseTextContentPart(
  value: unknown,
): value is LettaSseTextContentPart {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.type === "text" &&
    typeof value.text === "string" &&
    isOptionalString(value.signature)
  );
}

function isLettaSseAssistantMessage(
  value: unknown,
): value is LettaSseAssistantMessage {
  if (!isRecord(value) || value.message_type !== "assistant_message") {
    return false;
  }
  const content = value.content;
  return (
    typeof content === "undefined" ||
    typeof content === "string" ||
    (Array.isArray(content) && content.every(isLettaSseTextContentPart))
  );
}

function isLettaSseErrorMessage(value: unknown): value is LettaSseErrorMessage {
  if (!isRecord(value) || value.message_type !== "error_message") {
    return false;
  }
  return (
    isOptionalString(value.error_type) &&
    isOptionalString(value.message) &&
    isOptionalString(value.detail) &&
    isOptionalString(value.run_id)
  );
}

function isLettaSseStopReasonMessage(
  value: unknown,
): value is LettaSseStopReasonMessage {
  if (!isRecord(value) || value.message_type !== "stop_reason") {
    return false;
  }
  return isOptionalString(value.stop_reason);
}

function coreErrorFromMessage(
  message: LettaSseErrorMessage,
): LettaStreamCoreError {
  return new LettaStreamCoreError({
    errorType: message.error_type,
    message: message.message ?? "Core failed to generate a response.",
    detail: message.detail,
    runId: message.run_id,
  });
}

function collectAssistantContent(message: LettaSseAssistantMessage): string[] {
  if (typeof message.content === "string") {
    return [message.content];
  }
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text);
  }
  return [];
}

export async function collectLettaSseAssistantText(
  body: ReadableStream<Uint8Array>,
  options: CollectLettaSseAssistantTextOptions = {},
): Promise<CollectLettaSseAssistantTextResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const assistantMessages: string[] = [];
  let stopReason: string | undefined;

  async function processData(data: string): Promise<void> {
    if (data === "[DONE]") {
      return;
    }

    const parsed: unknown = JSON.parse(data);
    await options.onDelta?.(parsed);
    const progressUpdates = options.progressBuilder?.buildUpdates(parsed) ?? [];
    for (const update of progressUpdates) {
      await options.onProgressUpdate?.(update);
    }

    if (isLettaSseErrorMessage(parsed)) {
      throw coreErrorFromMessage(parsed);
    }
    if (isLettaSseAssistantMessage(parsed)) {
      assistantMessages.push(...collectAssistantContent(parsed));
      return;
    }
    if (isLettaSseStopReasonMessage(parsed)) {
      stopReason = parsed.stop_reason;
    }
  }

  async function processLine(line: string): Promise<void> {
    if (!line.trim() || !line.startsWith("data: ")) {
      return;
    }
    await processData(line.slice(6));
  }

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        await processLine(line);
      }
    }

    const flushed = decoder.decode();
    if (flushed) {
      buffer += flushed;
    }
    if (buffer) {
      await processLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  const text = assistantMessages.join(" ").trim();
  if (!text) {
    throw new LettaStreamNoAssistantMessageError();
  }

  return {
    text,
    chunkCount: assistantMessages.length,
    stopReason,
  };
}
