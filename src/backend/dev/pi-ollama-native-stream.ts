import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { isRecord } from "@/utils/type-guards";

const IMAGE_OMITTED_TEXT = "(image omitted: model does not support images)";

type OllamaNativeMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: Array<{
    id?: string;
    type?: "function";
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  tool_name?: string;
  tool_call_id?: string;
};

type OllamaNativePayload = {
  model: string;
  messages: OllamaNativeMessage[];
  stream: true;
  options?: Record<string, unknown>;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: unknown;
    };
  }>;
};

type OllamaNativeChunk = {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: unknown;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

function emptyUsage(input = 0, output = 0): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function baseAssistantMessage(model: Model<string>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function normalizeOllamaApiChatUrl(baseUrl: string | undefined): string {
  const url = new URL(baseUrl || "http://localhost:11434/v1");
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  const withoutOpenAiSuffix = trimmedPath.endsWith("/v1")
    ? trimmedPath.slice(0, -3)
    : trimmedPath;
  url.pathname = `${withoutOpenAiSuffix || ""}/api/chat`.replace(/\/+/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function modelSupportsImages(model: Model<string>): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function stripDataUrlPrefix(data: string): string {
  const comma = data.indexOf(",");
  if (data.startsWith("data:") && comma >= 0) return data.slice(comma + 1);
  return data;
}

function textFromTextBlocks(
  content: string | Array<TextContent | ImageContent>,
  model: Model<string>,
): { text: string; images?: string[] } {
  if (typeof content === "string") return { text: content };

  const parts: string[] = [];
  const images: string[] = [];
  const supportsImages = modelSupportsImages(model);
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "image") {
      if (supportsImages) {
        images.push(stripDataUrlPrefix(part.data));
      } else {
        parts.push(IMAGE_OMITTED_TEXT);
      }
    }
  }
  return { text: parts.join("\n"), ...(images.length ? { images } : {}) };
}

function assistantText(
  content: Array<TextContent | ThinkingContent | ToolCall>,
) {
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assistantThinking(
  content: Array<TextContent | ThinkingContent | ToolCall>,
): string | undefined {
  const thinking = content
    .filter((part): part is ThinkingContent => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
  return thinking.length > 0 ? thinking : undefined;
}

function assistantToolCalls(
  content: Array<TextContent | ThinkingContent | ToolCall>,
): OllamaNativeMessage["tool_calls"] | undefined {
  const calls = content
    .filter((part): part is ToolCall => part.type === "toolCall")
    .map((part) => ({
      id: part.id,
      type: "function" as const,
      function: { name: part.name, arguments: part.arguments },
    }));
  return calls.length > 0 ? calls : undefined;
}

function toOllamaMessages(
  model: Model<string>,
  context: Context,
): OllamaNativeMessage[] {
  const messages: OllamaNativeMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      const { text, images } = textFromTextBlocks(message.content, model);
      messages.push({
        role: "user",
        content: text,
        ...(images ? { images } : {}),
      });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = assistantToolCalls(message.content);
      messages.push({
        role: "assistant",
        content: assistantText(message.content),
        ...(assistantThinking(message.content)
          ? { thinking: assistantThinking(message.content) }
          : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const { text, images } = textFromTextBlocks(message.content, model);
    messages.push({
      role: "tool",
      content: text,
      tool_name: message.toolName,
      tool_call_id: message.toolCallId,
      ...(images ? { images } : {}),
    });
  }
  return messages;
}

function toOllamaTools(
  tools: Tool[] | undefined,
): OllamaNativePayload["tools"] {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function optionsNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function buildPayload(
  model: Model<string>,
  context: Context,
  options: (SimpleStreamOptions & Record<string, unknown>) | undefined,
): OllamaNativePayload {
  const nativeOptions: Record<string, unknown> = {};
  const contextWindow = optionsNumber(model.contextWindow);
  const maxTokens = optionsNumber(options?.maxTokens ?? model.maxTokens);
  if (contextWindow) nativeOptions.num_ctx = contextWindow;
  if (maxTokens) nativeOptions.num_predict = maxTokens;

  const tools = toOllamaTools(context.tools);
  return {
    model: model.id,
    messages: toOllamaMessages(model, context),
    stream: true,
    ...(Object.keys(nativeOptions).length > 0
      ? { options: nativeOptions }
      : {}),
    ...(tools ? { tools } : {}),
  };
}

function headersForOptions(
  options: (SimpleStreamOptions & Record<string, unknown>) | undefined,
): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options?.apiKey && options.apiKey !== "not-needed") {
    headers.set("Authorization", `Bearer ${options.apiKey}`);
  }
  if (isRecord(options?.headers)) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
  }
  return headers;
}

function signalForOptions(
  options: (SimpleStreamOptions & Record<string, unknown>) | undefined,
): AbortSignal | undefined {
  return options?.signal instanceof AbortSignal ? options.signal : undefined;
}

function timeoutForOptions(
  options: (SimpleStreamOptions & Record<string, unknown>) | undefined,
): number | undefined {
  return optionsNumber(options?.timeoutMs);
}

function mapDoneReason(reason: string | undefined): "stop" | "length" {
  return reason === "length" ? "length" : "stop";
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      return { value };
    }
    return { value };
  }
  return {};
}

function nativeToolCalls(chunk: OllamaNativeChunk): ToolCall[] {
  const calls = chunk.message?.tool_calls ?? [];
  return calls.flatMap((call, index) => {
    const name = call.function?.name;
    if (!name) return [];
    return [
      {
        type: "toolCall" as const,
        id: call.id || `ollama-tool-${index}`,
        name,
        arguments: normalizeToolArguments(call.function?.arguments),
      },
    ];
  });
}

async function applyPayloadHook(
  payload: OllamaNativePayload,
  model: Model<string>,
  options: (SimpleStreamOptions & Record<string, unknown>) | undefined,
): Promise<OllamaNativePayload> {
  const hooked = await options?.onPayload?.(payload, model);
  if (hooked !== undefined && isRecord(hooked)) {
    return hooked as OllamaNativePayload;
  }
  return payload;
}

async function streamNativeOllama(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  context: Context,
  options: (SimpleStreamOptions & Record<string, unknown>) | undefined,
): Promise<void> {
  let partial = baseAssistantMessage(model);
  stream.push({ type: "start", partial });

  let textIndex: number | undefined;
  let text = "";
  let thinkingIndex: number | undefined;
  let thinking = "";

  const pushError = (errorMessage: string) => {
    const error: AssistantMessage = {
      ...partial,
      stopReason: "error",
      errorMessage,
      timestamp: Date.now(),
    };
    stream.push({ type: "error", reason: "error", error });
  };

  try {
    const payload = await applyPayloadHook(
      buildPayload(model, context, options),
      model,
      options,
    );
    const controller = new AbortController();
    const upstreamSignal = signalForOptions(options);
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal) {
      if (upstreamSignal.aborted) abortFromUpstream();
      upstreamSignal.addEventListener("abort", abortFromUpstream, {
        once: true,
      });
    }
    const timeout = timeoutForOptions(options);
    const timer = timeout
      ? setTimeout(
          () => controller.abort(new Error("Ollama request timed out")),
          timeout,
        )
      : undefined;

    let response: Response;
    try {
      response = await fetch(normalizeOllamaApiChatUrl(model.baseUrl), {
        method: "POST",
        headers: headersForOptions(options),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (upstreamSignal) {
        upstreamSignal.removeEventListener("abort", abortFromUpstream);
      }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      pushError(
        `Ollama request failed (${response.status}): ${body || response.statusText}`,
      );
      return;
    }
    if (!response.body) {
      pushError("Ollama response did not include a stream body");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let finalChunk: OllamaNativeChunk | undefined;
    let pendingToolCalls: ToolCall[] = [];

    const processLine = (line: string) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as OllamaNativeChunk;
      if (chunk.error) {
        pushError(chunk.error);
        return;
      }

      const deltaThinking = chunk.message?.thinking ?? "";
      if (deltaThinking) {
        if (thinkingIndex === undefined) {
          thinkingIndex = partial.content.length;
          partial = {
            ...partial,
            content: [...partial.content, { type: "thinking", thinking: "" }],
          };
          stream.push({
            type: "thinking_start",
            contentIndex: thinkingIndex,
            partial,
          });
        }
        thinking += deltaThinking;
        partial = {
          ...partial,
          content: partial.content.map((part, index) =>
            index === thinkingIndex && part.type === "thinking"
              ? { ...part, thinking }
              : part,
          ),
        };
        stream.push({
          type: "thinking_delta",
          contentIndex: thinkingIndex,
          delta: deltaThinking,
          partial,
        });
      }

      const deltaText = chunk.message?.content ?? "";
      if (deltaText) {
        if (thinkingIndex !== undefined) {
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingIndex,
            content: thinking,
            partial,
          });
          thinkingIndex = undefined;
        }
        if (textIndex === undefined) {
          textIndex = partial.content.length;
          partial = {
            ...partial,
            content: [...partial.content, { type: "text", text: "" }],
          };
          stream.push({ type: "text_start", contentIndex: textIndex, partial });
        }
        text += deltaText;
        partial = {
          ...partial,
          content: partial.content.map((part, index) =>
            index === textIndex && part.type === "text"
              ? { ...part, text }
              : part,
          ),
        };
        stream.push({
          type: "text_delta",
          contentIndex: textIndex,
          delta: deltaText,
          partial,
        });
      }

      const toolCalls = nativeToolCalls(chunk);
      if (toolCalls.length > 0) pendingToolCalls = toolCalls;
      if (chunk.done) finalChunk = chunk;
    };

    while (true) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      if (done) break;
    }
    if (buffered.trim()) processLine(buffered);

    if (thinkingIndex !== undefined) {
      stream.push({
        type: "thinking_end",
        contentIndex: thinkingIndex,
        content: thinking,
        partial,
      });
    }
    if (textIndex !== undefined) {
      stream.push({
        type: "text_end",
        contentIndex: textIndex,
        content: text,
        partial,
      });
    }

    for (const toolCall of pendingToolCalls) {
      const contentIndex = partial.content.length;
      partial = { ...partial, content: [...partial.content, toolCall] };
      stream.push({ type: "toolcall_start", contentIndex, partial });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
    }

    const inputTokens = finalChunk?.prompt_eval_count ?? 0;
    const outputTokens = finalChunk?.eval_count ?? 0;
    const stopReason =
      pendingToolCalls.length > 0
        ? "toolUse"
        : mapDoneReason(finalChunk?.done_reason);
    const finalMessage: AssistantMessage = {
      ...partial,
      responseModel: finalChunk?.model,
      usage: emptyUsage(inputTokens, outputTokens),
      stopReason,
      timestamp: Date.now(),
    };
    stream.push({
      type: "done",
      reason: stopReason,
      message: finalMessage,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stopReason =
      error instanceof Error && error.name === "AbortError"
        ? "aborted"
        : "error";
    const assistantError: AssistantMessage = {
      ...partial,
      stopReason,
      errorMessage,
      timestamp: Date.now(),
    };
    stream.push({ type: "error", reason: stopReason, error: assistantError });
  }
}

export function streamOllamaNativeSimple(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void streamNativeOllama(stream, model, context, options);
  return stream;
}
