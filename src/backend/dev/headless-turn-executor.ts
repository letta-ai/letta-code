import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationMessageCreateBody,
  ConversationMessageStreamBody,
} from "@/backend/backend";
import type { LocalMessage } from "@/backend/local/local-message";
import type {
  LocalAgentRecord,
  StoredMessage,
} from "@/backend/local/local-store";

export type HeadlessTurnBody =
  | ConversationMessageCreateBody
  | ConversationMessageStreamBody;

export interface HeadlessTurnExecutorInput {
  conversationId: string;
  agentId: string;
  agent: LocalAgentRecord;
  systemPrompt?: string;
  midConversationSystemPrompt?: string;
  body: HeadlessTurnBody;
  history: StoredMessage[];
  uiMessages: LocalMessage[];
}

export interface HeadlessTurnExecutor {
  execute(
    input: HeadlessTurnExecutorInput,
  ): Promise<Stream<LettaStreamingResponse>>;
}

function createStream(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function createDelayedStream(
  chunks: LettaStreamingResponse[],
  delayMs: number,
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  const waitForDelay = () =>
    new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), delayMs);
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve(true);
        },
        { once: true },
      );
    });

  return {
    controller,
    async *[Symbol.asyncIterator]() {
      if (delayMs > 0 && (await waitForDelay())) return;
      for (const chunk of chunks) {
        if (controller.signal.aborted) return;
        yield chunk;
      }
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

export function createAssistantMessageStream(
  message: Partial<Pick<StoredMessage, "id" | "date" | "content">> = {},
): Stream<LettaStreamingResponse> {
  return createStream([
    {
      message_type: "assistant_message",
      ...(message.id ? { id: message.id } : {}),
      ...(message.date ? { date: message.date } : {}),
      content: message.content ?? [{ type: "text", text: "pong" }],
    } as LettaStreamingResponse,
    {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    } as LettaStreamingResponse,
  ]);
}

function hasApprovalResults(body: HeadlessTurnBody): boolean {
  const messages = (body as { messages?: Array<Record<string, unknown>> })
    .messages;
  return (messages ?? []).some((message) => message.type === "approval");
}

function summarizeApprovalResults(body: HeadlessTurnBody): string {
  const messages =
    (
      body as {
        messages?: Array<{ approvals?: Array<Record<string, unknown>> }>;
      }
    ).messages ?? [];
  const approvals = messages.flatMap((message) => message.approvals ?? []);
  const firstToolResult = approvals.find(
    (approval) => approval.type === "tool",
  );
  const status =
    typeof firstToolResult?.status === "string"
      ? firstToolResult.status
      : "unknown";
  const toolReturn = firstToolResult?.tool_return;
  const text =
    typeof toolReturn === "string"
      ? toolReturn
      : JSON.stringify(toolReturn ?? "");
  return `tool result received (${status}): ${text.slice(0, 240)}`;
}

export class DeterministicPongExecutor implements HeadlessTurnExecutor {
  async execute(_input: HeadlessTurnExecutorInput) {
    return createAssistantMessageStream();
  }
}

export class DeterministicToolCallExecutor implements HeadlessTurnExecutor {
  private toolCallSeq = 0;

  async execute(input: HeadlessTurnExecutorInput) {
    if (hasApprovalResults(input.body)) {
      return createAssistantMessageStream({
        content: [{ type: "text", text: summarizeApprovalResults(input.body) }],
      });
    }

    this.toolCallSeq += 1;
    const toolCallId = `tool-call-fake-shell-${this.toolCallSeq}`;
    const delayMs =
      Number(process.env.LETTA_CODE_FAKE_HEADLESS_TOOL_DELAY_MS ?? "0") || 0;
    const command =
      process.env.LETTA_CODE_FAKE_HEADLESS_TOOL_COMMAND ??
      "echo deterministic-tool-ok";
    const description =
      process.env.LETTA_CODE_FAKE_HEADLESS_TOOL_DESCRIPTION ??
      "Run deterministic tool call";
    const chunks = [
      {
        message_type: "approval_request_message",
        tool_call: {
          tool_call_id: toolCallId,
          name: "Bash",
          arguments: JSON.stringify({
            command,
            description,
            login: false,
          }),
        },
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "requires_approval",
      } as LettaStreamingResponse,
    ];
    return delayMs > 0
      ? createDelayedStream(chunks, delayMs)
      : createStream(chunks);
  }
}
