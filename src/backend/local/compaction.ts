import { generateText, type LanguageModel } from "ai";
import { createAISDKModelFactoryFromAgent } from "../dev/AISDKModelFactory";
import { buildAISDKProviderOptions } from "../dev/AISDKStreamAdapter";
import { isContextWindowOverflowError } from "../dev/contextWindowOverflow";
import type { LocalMessage } from "./LocalMessage";
import type { LocalAgentRecord } from "./LocalStore";

const ALL_WORD_LIMIT = 500;
const SUMMARY_TRUNCATION_SUFFIX = "... [summary truncated to fit]";
const TOOL_TRANSCRIPT_TRUNCATION_CHARS = 4000;
const TRANSCRIPT_FALLBACK_MAX_CHARS = 120000;

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

export interface LocalCompactionStats {
  trigger?: string;
  context_tokens_before?: number;
  context_tokens_after?: number;
  context_window?: number;
  messages_count_before?: number;
  messages_count_after?: number;
}

export type LocalGenerateTextFunction = (options: {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
  maxRetries: number;
  abortSignal?: AbortSignal;
}) => ReturnType<typeof generateText>;

export interface LocalAllCompactionInput {
  agent: LocalAgentRecord;
  messages: LocalMessage[];
  createModel?: () => LanguageModel;
  generateText?: LocalGenerateTextFunction;
  prompt?: string | null;
  clipChars?: number | null;
  abortSignal?: AbortSignal;
  localProviderAuthStorageDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}… [truncated ${value.length - maxChars} chars]`;
}

function toolPartSummary(
  part: Record<string, unknown>,
  truncationChars?: number,
) {
  const toolName = String(part.type).slice("tool-".length);
  const input = truncate(
    stringifyUnknown(part.input),
    truncationChars ?? Number.POSITIVE_INFINITY,
  );
  const state = typeof part.state === "string" ? part.state : "unknown";
  const output =
    part.output !== undefined || part.errorText !== undefined
      ? `\noutput: ${truncate(
          stringifyUnknown(part.output ?? part.errorText),
          truncationChars ?? Number.POSITIVE_INFINITY,
        )}`
      : "";
  return `[tool ${toolName} state=${state}]\ninput: ${input}${output}`;
}

function partText(
  part: LocalMessage["parts"][number],
  truncationChars?: number,
) {
  if (!isRecord(part)) return stringifyUnknown(part);
  if (
    (part.type === "text" || part.type === "reasoning") &&
    typeof part.text === "string"
  ) {
    return part.type === "reasoning" ? `[reasoning]\n${part.text}` : part.text;
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return toolPartSummary(part, truncationChars);
  }
  return truncate(
    stringifyUnknown(part),
    truncationChars ?? Number.POSITIVE_INFINITY,
  );
}

export function formatLocalMessagesForSummary(
  messages: LocalMessage[],
  options: { truncationChars?: number; maxChars?: number } = {},
): string {
  const transcript = messages
    .map((message, index) => {
      const compactionSummary = message.metadata?.compaction?.summary;
      const body =
        typeof compactionSummary === "string"
          ? compactionSummary
          : message.parts
              .map((part) => partText(part, options.truncationChars))
              .filter((text) => text.length > 0)
              .join("\n");
      return `<message index="${index + 1}" role="${message.role}">\n${body}\n</message>`;
    })
    .join("\n\n");
  if (options.maxChars && transcript.length > options.maxChars) {
    return `${transcript.slice(
      transcript.length - options.maxChars,
    )}\n\n[Earlier transcript content was truncated to fit the summarizer context window.]`;
  }
  return transcript;
}

async function runGenerateText(
  input: LocalAllCompactionInput,
  transcript: string,
) {
  const run = input.generateText ?? generateText;
  return run({
    model:
      input.createModel?.() ??
      createAISDKModelFactoryFromAgent(
        input.agent.model,
        input.agent.model_settings,
        { localProviderAuthStorageDir: input.localProviderAuthStorageDir },
      )(),
    system: input.prompt ?? LOCAL_ALL_COMPACTION_PROMPT,
    prompt: transcript,
    providerOptions: buildAISDKProviderOptions(
      input.agent.model,
      input.agent.model_settings,
    ),
    maxRetries: 0,
    abortSignal: input.abortSignal,
  });
}

export async function summarizeLocalMessagesAll(
  input: LocalAllCompactionInput,
): Promise<string> {
  if (input.messages.length === 0) return "No prior conversation messages.";
  const primaryTranscript = formatLocalMessagesForSummary(input.messages);
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await runGenerateText(input, primaryTranscript);
  } catch (error) {
    if (!isContextWindowOverflowError(error)) throw error;
    const fallbackTranscript = formatLocalMessagesForSummary(input.messages, {
      truncationChars: TOOL_TRANSCRIPT_TRUNCATION_CHARS,
      maxChars: TRANSCRIPT_FALLBACK_MAX_CHARS,
    });
    result = await runGenerateText(input, fallbackTranscript);
  }

  let summary = result.text.trim();
  const clipChars = input.clipChars === undefined ? 50000 : input.clipChars;
  if (clipChars !== null && summary.length > clipChars) {
    summary = `${summary.slice(0, clipChars)}${SUMMARY_TRUNCATION_SUFFIX}`;
  }
  return summary;
}

export function estimateLocalMessageTokens(messages: LocalMessage[]): number {
  const chars = messages.reduce(
    (total, message) => total + JSON.stringify(message).length,
    0,
  );
  return Math.ceil(chars / 4);
}

export function packageLocalSummaryMessage(
  summary: string,
  stats?: LocalCompactionStats,
): string {
  const message = `Note: prior messages with the user are available in external context. Messages are a record of the conversation history, or "events," containing user or system/automated inputs, reasoning traces, agent outputs, tool calls, and tool responses. As a Letta agent, your conversation history is automatically managed by the system — old messages will be periodically evicted from the conversation history and replaced with a recursive summary ("compaction"), yet all messages are persisted and remain retrievable through active tool calling.\nThe following is an in-context recursive summary of the prior messages: ${summary}`;
  return JSON.stringify({
    type: "system_alert",
    message,
    time: new Date().toISOString(),
    ...(stats ? { compaction_stats: stats } : {}),
  });
}
