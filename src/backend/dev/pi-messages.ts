import type { Message, Tool, TSchema } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { LocalMessage } from "@/backend/local/local-message";
import { removeOrphanLocalToolResults } from "@/backend/local/local-message-projection";
import type { ClientTool } from "@/tools/manager";
import { isRecord } from "@/utils/type-guards";

function isClientTool(value: unknown): value is ClientTool {
  return isRecord(value) && typeof value.name === "string";
}

export function toPiTools(clientTools: unknown[]): Tool[] | undefined {
  const tools: Tool[] = [];
  for (const value of clientTools) {
    if (!isClientTool(value)) continue;
    const schema = isRecord(value.parameters)
      ? (value.parameters as unknown as TSchema)
      : Type.Object({});
    tools.push({
      name: value.name,
      description: value.description ?? "",
      parameters: schema,
    });
  }
  return tools.length > 0 ? tools : undefined;
}

const EMPTY_TOOL_RESULT_PLACEHOLDER = "No result provided";

type LocalUserContent = Extract<LocalMessage, { role: "user" }>["content"];
type LocalAssistantContent = Extract<
  LocalMessage,
  { role: "assistant" }
>["content"];
type LocalToolResultContent = Extract<
  LocalMessage,
  { role: "toolResult" }
>["content"];

function isEmptyTextBlock(block: { type: string; text?: unknown }): boolean {
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim().length === 0
  );
}

function dropEmptyTextBlocks<T extends { type: string; text?: unknown }>(
  content: T[],
): T[] {
  return content.filter((block) => !isEmptyTextBlock(block));
}

function normalizeUserContent(
  content: LocalUserContent,
): LocalUserContent | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAssistantContent(
  content: LocalAssistantContent,
): LocalAssistantContent | undefined {
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeToolResultContent(
  content: LocalToolResultContent,
): LocalToolResultContent {
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0
    ? normalized
    : [{ type: "text", text: EMPTY_TOOL_RESULT_PLACEHOLDER }];
}

export function toPiMessage(message: LocalMessage): Message | undefined {
  if (message.role === "user") {
    const content = normalizeUserContent(message.content);
    if (!content) return undefined;
    return {
      role: "user",
      content,
      timestamp: message.timestamp,
    } satisfies Message;
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: normalizeToolResultContent(message.content),
      details: message.details,
      isError: message.isError,
      timestamp: message.timestamp,
    } satisfies Message;
  }
  const content = normalizeAssistantContent(message.content);
  if (!content) return undefined;
  return {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
    usage: message.usage,
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
  } satisfies Message;
}

/** Provider-safe history for a request that continues after it. */
export function toPiHistoryMessages(
  messages: readonly LocalMessage[],
): Message[] {
  return removeOrphanLocalToolResults(messages).messages.flatMap((message) => {
    const piMessage = toPiMessage(message);
    return piMessage ? [piMessage] : [];
  });
}

export function toPiMessages(messages: readonly LocalMessage[]): Message[] {
  let normalized = toPiHistoryMessages(messages);

  // Strip trailing assistant messages after normalization. Providers like
  // Anthropic require the conversation to end with a user or tool-result
  // message, and dropping empty text-only user messages can expose a trailing
  // partial assistant response from a failed turn.
  while (normalized.length > 0 && normalized.at(-1)?.role === "assistant") {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}
