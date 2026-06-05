import { describe, expect, test } from "bun:test";
import {
  estimateProviderProjectedLocalMessageTokens,
  formatLocalMessagesForSummary,
  type LocalCompactionStats,
  packageLocalSummaryMessage,
} from "@/backend/local/compaction";
import {
  emptyLocalUsage,
  type LocalMessage,
} from "@/backend/local/local-message";
import { LOCAL_PROVIDER_TOOL_RESULT_TEXT_MAX_CHARS } from "@/backend/local/local-message-projection";

function user(
  id: string,
  content: Extract<LocalMessage, { role: "user" }>["content"],
  metadata?: Extract<LocalMessage, { role: "user" }>["metadata"],
): LocalMessage {
  return {
    id,
    role: "user",
    content,
    timestamp: 1,
    ...(metadata ? { metadata } : {}),
  };
}

function assistant(
  id: string,
  content: Extract<LocalMessage, { role: "assistant" }>["content"],
): LocalMessage {
  return {
    id,
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
}

function toolResult(
  id: string,
  content: Extract<LocalMessage, { role: "toolResult" }>["content"],
): LocalMessage {
  return {
    id,
    role: "toolResult",
    toolCallId: "call-shell",
    toolName: "ShellCommand",
    content,
    isError: false,
    timestamp: 1,
  };
}

describe("local compaction API parity", () => {
  test("formats local messages with the API simple_formatter transcript contract", () => {
    const transcript = formatLocalMessagesForSummary([
      user("user-1", [
        { type: "text", text: "Please inspect this screenshot." },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ]),
      assistant("assistant-1", [
        { type: "thinking", thinking: "I should inspect the directory first." },
        {
          type: "toolCall",
          id: "call-shell",
          name: "ShellCommand",
          arguments: { command: "ls", workdir: "/repo" },
        },
        { type: "text", text: "The repo has source and docs." },
      ]),
      toolResult("tool-1", [{ type: "text", text: "README.md\nsrc" }]),
    ]);

    expect(transcript).toBe(
      ' \n[user] Please inspect this screenshot. [Image omitted]\n[assistant] I should inspect the directory first.\n\nThe repo has source and docs. -> ShellCommand({"command":"ls","workdir":"/repo"})\n[tool] README.md\nsrc\n \n. Generate the summary.',
    );
    expect(transcript).not.toContain("step-start");
    expect(transcript).not.toContain("<message");
    expect(transcript).not.toContain("state=output-available");
  });

  test("uses API tool-return truncation semantics in fallback transcripts", () => {
    const transcript = formatLocalMessagesForSummary(
      [
        assistant("assistant-tool", [
          {
            type: "toolCall",
            id: "call-big",
            name: "ShellCommand",
            arguments: { command: "cat huge.log" },
          },
        ]),
        {
          id: "tool-big",
          role: "toolResult",
          toolCallId: "call-big",
          toolName: "ShellCommand",
          content: [{ type: "text", text: `${"x".repeat(12)}END` }],
          isError: false,
          timestamp: 1,
        },
      ],
      { truncationChars: 10 },
    );

    expect(transcript).toBe(
      ' \n[assistant] -> ShellCommand({"command":"cat huge.log"})\n[tool] xxxxxxxxxx... [truncated 5 chars]\n \n. Generate the summary.',
    );
  });

  test("estimates compacted context using provider-projected tool results", () => {
    const projectedTokens = estimateProviderProjectedLocalMessageTokens([
      assistant("assistant-tool", [
        {
          type: "toolCall",
          id: "call-big",
          name: "ShellCommand",
          arguments: { command: "cat huge.log" },
        },
      ]),
      toolResult("tool-big", [
        { type: "text", text: `${"x".repeat(100_000)}TAIL` },
      ]),
    ]);

    expect(projectedTokens).toBeLessThan(
      Math.ceil((LOCAL_PROVIDER_TOOL_RESULT_TEXT_MAX_CHARS + 10_000) / 4),
    );
  });

  test("uses raw compaction summaries for recursive compaction", () => {
    const packedSummary = JSON.stringify({
      type: "system_alert",
      message:
        "Note: prior messages have been hidden from view due to conversation memory constraints.\nThe following is a summary of the previous messages:\n raw recursive summary",
      time: "2026-01-01T00:00:00.000Z",
    });

    const transcript = formatLocalMessagesForSummary([
      user("summary-1", [{ type: "text", text: packedSummary }], {
        compaction: { summary: "raw recursive summary" },
      }),
    ]);

    expect(transcript).toBe(
      " \n[user] raw recursive summary\n \n. Generate the summary.",
    );
    expect(transcript).not.toContain("system_alert");
    expect(transcript).not.toContain("prior messages have been hidden");
  });

  test("packs all-mode summaries like API package_summarize_message_no_counts", () => {
    const stats: LocalCompactionStats = {
      trigger: "manual",
      messages_count_before: 12,
      messages_count_after: 1,
    };

    const packed = JSON.parse(
      packageLocalSummaryMessage("summary body", stats, "all"),
    ) as Record<string, unknown>;
    expect(packed.type).toBe("system_alert");
    expect(packed.message).toBe(
      "Note: prior messages have been hidden from view due to conversation memory constraints.\nThe following is a summary of the previous messages:\n summary body",
    );
    expect(packed.compaction_stats).toEqual(stats);
    expect(typeof packed.time).toBe("string");
  });

  test("packs sliding-window summaries like API package_summarize_message_no_counts", () => {
    const stats: LocalCompactionStats = {
      trigger: "context_window_overflow",
      messages_count_before: 10,
      messages_count_after: 4,
    };

    const packed = JSON.parse(
      packageLocalSummaryMessage("sliding body", stats, "sliding_window"),
    ) as Record<string, unknown>;
    expect(packed.type).toBe("system_alert");
    expect(packed.message).toBe(
      "Note: 6 messages from the beginning of the conversation have been hidden from view due to memory constraints.\nThe following is a summary of the previous messages:\n sliding body",
    );
    expect(packed.compaction_stats).toEqual(stats);
    expect(typeof packed.time).toBe("string");
  });
});
