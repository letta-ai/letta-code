import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  HeadlessTurnBody,
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";

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

function hasApprovalResults(body: HeadlessTurnBody): boolean {
  const messages = (body as { messages?: Array<Record<string, unknown>> })
    .messages;
  return (messages ?? []).some((message) => message.type === "approval");
}

const SCRIPTED_TOOL_PATTERN = /^tool\s+([A-Za-z_][\w-]*)\s+(\{[\s\S]*\})\s*$/;
const SCRIPTED_WORD_DELAY_MS = 60;

function messageText(content: unknown): string {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part && typeof part === "object" && "text" in part
                ? String((part as { text: unknown }).text ?? "")
                : "",
            )
            .join("")
        : "";
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

function lastUserText(body: HeadlessTurnBody): string {
  const messages =
    (body as { messages?: Array<{ role?: string; content?: unknown }> })
      .messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = messageText(message.content);
    if (text) return text;
  }
  return "";
}

function createWordStream(text: string): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  const words = text.split(/(?<=\s)/);
  const id = `message-scripted-${Date.now().toString(36)}`;
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const word of words) {
        if (controller.signal.aborted) return;
        await new Promise((resolve) =>
          setTimeout(resolve, SCRIPTED_WORD_DELAY_MS),
        );
        yield {
          message_type: "assistant_message",
          id,
          content: [{ type: "text", text: word }],
        } as LettaStreamingResponse;
      }
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function scriptedToolSummary(body: HeadlessTurnBody): string {
  const messages =
    (
      body as {
        messages?: Array<{ approvals?: Array<Record<string, unknown>> }>;
      }
    ).messages ?? [];
  const results = messages.flatMap((message) => message.approvals ?? []);
  const statuses = results.map((result) =>
    typeof result.status === "string"
      ? result.status
      : result.approve === false
        ? "denied"
        : "unknown",
  );
  return `The tool call finished (${statuses.join(", ") || "unknown"}).`;
}

export class DeterministicScriptedExecutor implements HeadlessTurnExecutor {
  private toolCallSeq = 0;

  async execute(input: HeadlessTurnExecutorInput) {
    const text = lastUserText(input.body);
    if (!text && hasApprovalResults(input.body)) {
      return createWordStream(scriptedToolSummary(input.body));
    }
    const match = SCRIPTED_TOOL_PATTERN.exec(text);
    if (!match) {
      return createWordStream(`You said: ${text || "nothing"}`);
    }
    this.toolCallSeq += 1;
    return createStream([
      {
        message_type: "approval_request_message",
        tool_call: {
          tool_call_id: `tool-call-scripted-${this.toolCallSeq}`,
          name: match[1],
          arguments: match[2],
        },
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "requires_approval",
      } as LettaStreamingResponse,
    ]);
  }
}
