import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { isContextWindowOverflowError } from "@/backend/dev/context-window-overflow";
import {
  applyPiEnvOverrides,
  reasoningForSettings,
  resolvePiModelForAgent,
} from "@/backend/dev/pi-model-factory";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { estimateLocalMessagesTokens } from "@/backend/local/local-context-estimate";
import { isRecord } from "@/utils/type-guards";
import type { LocalMessage } from "./local-message";
import { resolveAvailableLocalModelForTurn } from "./local-model-config";
import type { LocalAgentRecord } from "./local-types";

const ALL_WORD_LIMIT = 500;
const SLIDING_WORD_LIMIT = 300;
const SUMMARY_TRUNCATION_SUFFIX = "... [summary truncated to fit]";
export const LOCAL_SUMMARY_TOOL_RETURN_TRUNCATION_CHARS = 2_000;
const FABLE_5_MODEL_ID = "claude-fable-5";
const FABLE_COMPACTION_SUMMARY_FALLBACK_MODEL = "anthropic/claude-opus-4-8";
const FABLE_COMPACTION_SUMMARY_FALLBACK_CONTEXT_WINDOW = 1_000_000;
const FABLE_COMPACTION_SUMMARY_FALLBACK_MAX_TOKENS = 128_000;
const TRANSCRIPT_FALLBACK_MAX_CHARS = 120000;
const TRANSCRIPT_FALLBACK_MAX_CHAR_STEPS = [
  TRANSCRIPT_FALLBACK_MAX_CHARS,
  90_000,
  60_000,
  40_000,
  25_000,
  15_000,
  10_000,
  6_000,
  4_000,
  2_000,
] as const;
export const LOCAL_DEFAULT_COMPACTION_MODE = "sliding_window";
export const LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE = 0.3;

export type LocalCompactionMode = "all" | "sliding_window";

export class LocalSlidingWindowCompactionPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSlidingWindowCompactionPlanningError";
  }
}

export function isLocalSlidingWindowCompactionPlanningError(
  error: unknown,
): error is LocalSlidingWindowCompactionPlanningError {
  return error instanceof LocalSlidingWindowCompactionPlanningError;
}

export const LOCAL_ALL_COMPACTION_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context. Your summary should include the following sections:

1.**High level goals**: What is the high level goal and ongoing task? Capture the user's explicit requests and intent in detail. If there is an existing summary in the transcript, make sure to take it into consideration to continue tracking the higher level goals and long-term progress.

2. **What happened**: The conversations, tasks, and exchanges that took place. What did the user ask for? What did you do? How did things progress? If there is a previous summary being evicted, please extract a concise version of the critical info from it.

3. **Important details**: Enumerate specific files and code sections examined, modified, or created, as well as important plan files, GitHub issues/PR links, and Linear ticket IDs. For each item, include why it matters and any relevant names, data, configs, or facts discussed.
   - **Preserve identifiers verbatim** (plan filename/path, exact URL, issue/PR number, ticket ID); do not paraphrase or truncate.
   - **Preserve referenced identifiers unless explicitly resolved**: Keep exact URLs/IDs from the conversation unless there is clear evidence they are no longer relevant.
   - Do not omit details likely to be referenced later.

4. **Errors and fixes**: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received and record verbatim if useful.

5. **Current state**:Describe in detail precisely what is currently being worked on, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.

6.**Optional Next Step**: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests and the most current task. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off.

7. **Lookup hints**: For any detailed content (long lists, extensive data, specific conversations) that couldn't fit in the summary, note the topic and key terms that could be used to find it in message history later.

Write in first person as a factual record of what occurred. Be concise but thorough - the goal is to preserve enough context that the recent messages make sense and important information isn't lost to prevent duplicate work or repeated mistakes.

Keep your summary under ${ALL_WORD_LIMIT} words. Only output the summary.`;

export const LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT = `The following messages are being evicted from the BEGINNING of your context window. Write a detailed summary that captures what happened in these messages to appear BEFORE the remaining recent messages in context, providing background for what comes after. Include the following sections:

1.**High level goals**: What is the high level goal and ongoing task? Capture the user's explicit requests and intent in detail. If there is an existing summary in the transcript, make sure to take it into consideration to continue tracking the higher level goals and long-term progress.

2. **What happened**: The conversations, tasks, and exchanges that took place. What did the user ask for? What did you do? How did things progress? If there is a previous summary being evicted, please extract a concise version of the critical info from it.

3. **Important details**: Enumerate specific files and code sections examined, modified, or created, as well as important plan files, GitHub issues/PR links, and Linear ticket IDs. For each item, include why it matters and any relevant names, data, configs, or facts discussed.
   - **Preserve identifiers verbatim** (plan filename/path, exact URL, issue/PR number, ticket ID); do not paraphrase or truncate.
   - **Preserve referenced identifiers unless explicitly resolved**: Keep exact URLs/IDs from the conversation unless there is clear evidence they are no longer relevant.
   - Do not omit details likely to be referenced later.

4. **Errors and fixes**: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received and record verbatim if useful.

5. **Lookup hints**: For any detailed content (long lists, extensive data, specific conversations) that couldn't fit in the summary, note the topic and key terms that could be used to find it in message history later.

Write in first person as a factual record of what occurred. Be thorough and detailed - the goal is to preserve enough context that the recent messages make sense and important information isn't lost to prevent duplicate work or repeated mistakes.

Keep your summary under ${SLIDING_WORD_LIMIT} words. Only output the summary.`;

export interface LocalCompactionStats {
  trigger?: string;
  context_tokens_before?: number;
  context_tokens_after?: number;
  context_window?: number;
  messages_count_before?: number;
  messages_count_after?: number;
}

export type LocalCompleteFunction = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
) => Promise<AssistantMessage>;

export interface LocalAllCompactionInput {
  agent: LocalAgentRecord;
  messages: LocalMessage[];
  complete?: LocalCompleteFunction;
  prompt?: string | null;
  clipChars?: number | null;
  abortSignal?: AbortSignal;
  localProviderAuthStorageDir?: string;
  modelsRuntime?: LocalPiModelsRuntime;
}

export interface LocalSlidingWindowCompactionPlan {
  messagesToSummarize: LocalMessage[];
  messagesToKeep: LocalMessage[];
  cutoffIndex: number;
}

export interface LocalAllCompactionPlan {
  messagesToSummarize: LocalMessage[];
  messagesToKeep: LocalMessage[];
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateToolReturn(content: string, limit?: number): string {
  if (limit === undefined || content.length <= limit) return content;
  return `${content.slice(0, limit)}... [truncated ${content.length - limit} chars]`;
}

function middleTruncateText(
  text: string,
  budgetChars: number,
  headFrac = 0.3,
  tailFrac = 0.3,
): string {
  if (budgetChars <= 0 || text.length <= budgetChars) return text;
  const headLength = Math.max(0, Math.floor(budgetChars * headFrac));
  let tailLength = Math.max(0, Math.floor(budgetChars * tailFrac));
  if (headLength + tailLength > budgetChars) {
    tailLength = Math.max(0, budgetChars - headLength);
  }

  const head = text.slice(0, headLength);
  const tail = tailLength > 0 ? text.slice(-tailLength) : "";
  const dropped = Math.max(0, text.length - (head.length + tail.length));
  const marker = `\n[TRUNCATED: dropped ${dropped} middle chars due to context budget]\n`;
  return `${head}${marker}${tail}`;
}

type SummaryOpenAIMessage = {
  role: "assistant" | "developer" | "system" | "tool" | "user";
  content?: string | null | Array<{ text?: string } | string>;
  tool_calls?: Array<{
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
};

function textFromUserContent(
  content: LocalMessage & { role: "user" },
): string | undefined {
  const value = content.content;
  if (typeof value === "string") return value || undefined;
  const textParts: string[] = [];
  let imageCount = 0;
  for (const part of value) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "image") imageCount += 1;
  }
  let textContent = textParts.join("\n\n");
  if (imageCount > 0) {
    const placeholder =
      imageCount === 1 ? "[Image omitted]" : `[${imageCount} images omitted]`;
    textContent = `${textContent}${textContent ? " " : ""}${placeholder}`;
  }
  return textContent || undefined;
}

function textFromAssistantContent(
  message: LocalMessage & { role: "assistant" },
): string | undefined {
  const textParts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "thinking") {
      textParts.push(part.thinking);
    }
  }
  const textContent = textParts.join("\n\n");
  return textContent || undefined;
}

function localToolCallArguments(input: unknown): string {
  return typeof input === "string" ? input : stringifyUnknown(input ?? {});
}

function toolReturnToText(
  value: LocalMessage & { role: "toolResult" },
): string | undefined {
  const textParts: string[] = [];
  let imageCount = 0;
  for (const item of value.content) {
    if (item.type === "text") {
      textParts.push(item.text);
      continue;
    }
    if (item.type === "image") imageCount += 1;
  }
  let result = textParts.join("\n");
  if (imageCount > 0) {
    const placeholder =
      imageCount === 1 ? "[Image omitted]" : `[${imageCount} images omitted]`;
    result = `${result}${result ? " " : ""}${placeholder}`;
  }
  return result || undefined;
}

function localMessagesToSummaryOpenAIDicts(
  messages: LocalMessage[],
  options: { toolReturnTruncationChars?: number } = {},
): SummaryOpenAIMessage[] {
  const result: SummaryOpenAIMessage[] = [];
  for (const message of messages) {
    const compactionSummary = message.metadata?.compaction?.summary;
    if (typeof compactionSummary === "string") {
      result.push({ role: "user", content: compactionSummary });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = message.content.filter(
        (part) => part.type === "toolCall",
      );
      const content = textFromAssistantContent(message) ?? null;
      if (content !== null || toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((toolCall) => ({
                  function: {
                    name: toolCall.name,
                    arguments: localToolCallArguments(toolCall.arguments),
                  },
                })),
              }
            : {}),
        });
      }
      continue;
    }

    if (message.role === "toolResult") {
      const returnText = toolReturnToText(message);
      result.push({
        role: "tool",
        content: returnText
          ? truncateToolReturn(returnText, options.toolReturnTruncationChars)
          : null,
      });
      continue;
    }

    if (message.role === "user") {
      const content = textFromUserContent(message);
      if (content !== undefined) {
        result.push({ role: "user", content });
      }
    }
  }
  return result;
}

function simpleFormatter(messages: SummaryOpenAIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    try {
      const role = message.role ?? "?";
      let content: unknown = message.content;
      if (Array.isArray(content)) {
        content = content
          .map((block) =>
            isRecord(block) && typeof block.text === "string"
              ? block.text
              : String(block),
          )
          .join(" ");
      }
      let text = typeof content === "string" ? content : "";
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const callParts = message.tool_calls.map((toolCall) => {
          const fn = toolCall.function ?? {};
          return `${fn.name ?? "?"}(${fn.arguments ?? ""})`;
        });
        text = `${text}${text ? " " : ""}-> ${callParts.join(", ")}`;
      }
      if (text) lines.push(`[${role}] ${text}`);
    } catch {
      lines.push(JSON.stringify(message));
    }
  }

  return ` \n${lines.join("\n")}\n \n. Generate the summary.`;
}

export function formatLocalMessagesForSummary(
  messages: LocalMessage[],
  options: { truncationChars?: number; maxChars?: number } = {},
): string {
  const transcript = simpleFormatter(
    localMessagesToSummaryOpenAIDicts(messages, {
      toolReturnTruncationChars:
        options.truncationChars ?? LOCAL_SUMMARY_TOOL_RETURN_TRUNCATION_CHARS,
    }),
  );
  return options.maxChars
    ? middleTruncateText(transcript, options.maxChars)
    : transcript;
}

function assistantMessageText(message: AssistantMessage): string {
  return message.content
    .map((content) => (content.type === "text" ? content.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

// Summarization dispatches through the pi-ai Models runtime like turn
// execution does; a compaction-only fallback runtime is created when the
// caller (tests, direct library use) did not thread the backend's instance.
function runtimeComplete(runtime: LocalPiModelsRuntime): LocalCompleteFunction {
  return async (model, context, options) => {
    if (model.api === "bedrock-converse-stream") {
      return runtime
        .stream(model as Model<string>, context, options as never)
        .result();
    }
    return runtime
      .streamSimple(model as Model<string>, context, options)
      .result();
  };
}

function isFableModel(model: Model<string>): boolean {
  return model.id.includes(FABLE_5_MODEL_ID);
}

function fableCompactionSummaryFallbackSettings(
  modelSettings: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...modelSettings,
    provider_type: "anthropic",
    parallel_tool_calls:
      typeof modelSettings.parallel_tool_calls === "boolean"
        ? modelSettings.parallel_tool_calls
        : true,
    context_window_limit:
      typeof modelSettings.context_window_limit === "number"
        ? modelSettings.context_window_limit
        : FABLE_COMPACTION_SUMMARY_FALLBACK_CONTEXT_WINDOW,
    max_tokens:
      typeof modelSettings.max_tokens === "number"
        ? modelSettings.max_tokens
        : FABLE_COMPACTION_SUMMARY_FALLBACK_MAX_TOKENS,
  };
}

async function runGenerateText(
  input: LocalAllCompactionInput,
  transcript: string,
  defaultPrompt: string,
): Promise<{ text: string }> {
  const systemPrompt = input.prompt ?? defaultPrompt;
  const modelsRuntime =
    input.modelsRuntime ??
    new LocalPiModelsRuntime({
      storageDir: input.localProviderAuthStorageDir,
    });
  let localModel = await resolveAvailableLocalModelForTurn({
    model: input.agent.model,
    modelSettings: input.agent.model_settings,
    storageDir: input.localProviderAuthStorageDir,
    modelsRuntime,
  });
  let resolved = await resolvePiModelForAgent(
    localModel.model,
    localModel.modelSettings,
    {
      localProviderAuthStorageDir: input.localProviderAuthStorageDir,
      modelsRuntime,
    },
  );
  if (
    resolved.model.api === "anthropic-messages" &&
    isFableModel(resolved.model)
  ) {
    // Fable 5 is a strong turn model, but compaction summaries can trip
    // Anthropic's refusal path and pi-ai currently surfaces that as the opaque
    // "An unknown error occurred". The summary model is an implementation
    // detail of compaction, so avoid Fable for this auxiliary call while
    // preserving the original Anthropic reasoning/settings shape.
    localModel = await resolveAvailableLocalModelForTurn({
      model: FABLE_COMPACTION_SUMMARY_FALLBACK_MODEL,
      modelSettings: fableCompactionSummaryFallbackSettings(
        localModel.modelSettings,
      ),
      storageDir: input.localProviderAuthStorageDir,
      modelsRuntime,
    });
    resolved = await resolvePiModelForAgent(
      localModel.model,
      localModel.modelSettings,
      {
        localProviderAuthStorageDir: input.localProviderAuthStorageDir,
        modelsRuntime,
      },
    );
  }
  const run = input.complete ?? runtimeComplete(modelsRuntime);
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
  };
  const reasoning = reasoningForSettings(
    localModel.modelSettings,
    localModel.model,
  );
  const options: SimpleStreamOptions & Record<string, unknown> = {
    ...resolved.providerOptions,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.timeout !== false ? { timeoutMs: resolved.timeout } : {}),
    ...(resolved.headers ? { headers: resolved.headers } : {}),
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
    // Mirrors Pi's createSummarizationOptions, which passes the session
    // thinking level into summarization requests. Required for adaptive
    // thinking Anthropic models (for example claude-fable-5): without
    // options.reasoning, pi-ai sends `thinking: {type: "disabled"}`, which
    // those models reject with a 400 invalid_request_error — breaking every
    // compaction (automatic and manual /compact).
    ...(reasoning ? { reasoning } : {}),
    maxRetries: 0,
  };
  const restoreEnv = applyPiEnvOverrides(resolved.envOverrides);
  let result: AssistantMessage;
  try {
    result = await run(resolved.model as Model<string>, context, options);
  } finally {
    restoreEnv();
  }
  if (isContextOverflow(result, resolved.model.contextWindow)) {
    throw new Error(result.errorMessage ?? "Context window exceeded");
  }
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage ?? "Local compaction failed");
  }
  return { text: assistantMessageText(result) };
}

async function summarizeLocalMessagesWithPrompt(
  input: LocalAllCompactionInput,
  defaultPrompt: string,
): Promise<string> {
  if (input.messages.length === 0) return "No prior conversation messages.";
  const primaryTranscript = formatLocalMessagesForSummary(input.messages, {
    truncationChars: LOCAL_SUMMARY_TOOL_RETURN_TRUNCATION_CHARS,
  });
  let result: { text: string } | undefined;
  try {
    result = await runGenerateText(input, primaryTranscript, defaultPrompt);
  } catch (error) {
    if (!isContextWindowOverflowError(error)) throw error;
    let overflowError: unknown = error;
    let previousTranscript: string | undefined;
    for (const maxChars of TRANSCRIPT_FALLBACK_MAX_CHAR_STEPS) {
      const fallbackTranscript = formatLocalMessagesForSummary(input.messages, {
        truncationChars: LOCAL_SUMMARY_TOOL_RETURN_TRUNCATION_CHARS,
        maxChars,
      });
      if (fallbackTranscript === previousTranscript) continue;
      previousTranscript = fallbackTranscript;
      try {
        result = await runGenerateText(
          input,
          fallbackTranscript,
          defaultPrompt,
        );
        break;
      } catch (fallbackError) {
        if (!isContextWindowOverflowError(fallbackError)) throw fallbackError;
        overflowError = fallbackError;
      }
    }
    if (!result) throw overflowError;
  }

  if (!result) {
    throw new Error("Compaction summarizer did not return a result.");
  }
  let summary = result.text.trim();
  const clipChars = input.clipChars === undefined ? 50000 : input.clipChars;
  if (clipChars !== null && summary.length > clipChars) {
    summary = `${summary.slice(0, clipChars)}${SUMMARY_TRUNCATION_SUFFIX}`;
  }
  return summary;
}

export async function summarizeLocalMessagesAll(
  input: LocalAllCompactionInput,
): Promise<string> {
  return summarizeLocalMessagesWithPrompt(input, LOCAL_ALL_COMPACTION_PROMPT);
}

function hasPendingLocalToolCall(message: LocalMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.some((part) => part.type === "toolCall")
  );
}

function normalizedSlidingWindowPercentage(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE;
  }
  if (value <= 0) return 0.1;
  if (value > 1) return 1;
  return value;
}

function isValidSlidingWindowCutoff(
  messages: LocalMessage[],
  index: number,
  maximumCutoffIndex: number,
): boolean {
  const message = messages[index];
  return (
    message?.role === "assistant" && index > 0 && index < maximumCutoffIndex
  );
}

export function planLocalSlidingWindowCompaction(
  messages: LocalMessage[],
  options: { slidingWindowPercentage?: number; contextWindow?: number } = {},
): LocalSlidingWindowCompactionPlan {
  if (messages.length < 4) {
    throw new LocalSlidingWindowCompactionPlanningError(
      "Not enough messages for sliding window compaction.",
    );
  }

  const percentage = normalizedSlidingWindowPercentage(
    options.slidingWindowPercentage,
  );
  const lastMessage = messages.at(-1);
  const maximumCutoffIndex =
    lastMessage && hasPendingLocalToolCall(lastMessage)
      ? messages.length - 2
      : messages.length - 1;
  const goalTokens =
    typeof options.contextWindow === "number" &&
    Number.isFinite(options.contextWindow)
      ? (1 - percentage) * options.contextWindow
      : undefined;
  let approxTokenCount = options.contextWindow ?? Number.POSITIVE_INFINITY;
  let cutoffIndex: number | undefined;

  let evictionPercentage = percentage;
  while (
    (goalTokens === undefined
      ? cutoffIndex === undefined
      : approxTokenCount >= goalTokens) &&
    evictionPercentage < 1.0
  ) {
    evictionPercentage += 0.1;
    const messageCutoffIndex = Math.min(
      Math.round(evictionPercentage * messages.length),
      messages.length - 1,
    );
    cutoffIndex = [...Array(messageCutoffIndex + 1).keys()]
      .reverse()
      .find((index) =>
        isValidSlidingWindowCutoff(messages, index, maximumCutoffIndex),
      );
    if (cutoffIndex === undefined) continue;

    const messagesToKeep = messages.slice(cutoffIndex);
    approxTokenCount = estimateLocalMessageTokens(messagesToKeep);
  }

  if (cutoffIndex === undefined || evictionPercentage >= 1.0) {
    throw new LocalSlidingWindowCompactionPlanningError(
      "No assistant message found for sliding window compaction.",
    );
  }

  if (cutoffIndex >= maximumCutoffIndex) {
    throw new LocalSlidingWindowCompactionPlanningError(
      `Assistant message index ${cutoffIndex} is at the end of the message buffer, skipping compaction.`,
    );
  }

  return {
    messagesToSummarize: messages.slice(0, cutoffIndex),
    messagesToKeep: messages.slice(cutoffIndex),
    cutoffIndex,
  };
}

export function planLocalAllCompaction(
  messages: LocalMessage[],
): LocalAllCompactionPlan {
  const lastMessage = messages.at(-1);
  if (lastMessage && hasPendingLocalToolCall(lastMessage)) {
    return {
      messagesToSummarize: messages.slice(0, -1),
      messagesToKeep: [lastMessage],
    };
  }

  return {
    messagesToSummarize: messages,
    messagesToKeep: [],
  };
}

export async function summarizeLocalMessagesSlidingWindow(
  input: LocalAllCompactionInput,
): Promise<string> {
  return summarizeLocalMessagesWithPrompt(
    input,
    LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
  );
}

export function estimateLocalMessageTokens(messages: LocalMessage[]): number {
  return estimateLocalMessagesTokens(messages);
}

export function packageLocalSummaryMessage(
  summary: string,
  stats?: LocalCompactionStats,
  mode?: LocalCompactionMode,
): string {
  let message: string;
  if (mode?.includes("sliding_window")) {
    if (
      stats?.messages_count_before !== undefined &&
      stats.messages_count_after !== undefined
    ) {
      const numEvicted =
        stats.messages_count_before - stats.messages_count_after;
      message = `Note: ${numEvicted} messages from the beginning of the conversation have been hidden from view due to memory constraints.\nThe following is a summary of the previous messages:\n ${summary}`;
    } else {
      message = `Note: prior messages from the beginning of the conversation have been hidden from view due to conversation memory constraints.\nThe following is a summary of the previous messages:\n ${summary}`;
    }
  } else {
    message = `Note: prior messages have been hidden from view due to conversation memory constraints.\nThe following is a summary of the previous messages:\n ${summary}`;
  }
  return JSON.stringify({
    type: "system_alert",
    message,
    time: new Date().toISOString(),
    ...(stats ? { compaction_stats: stats } : {}),
  });
}
