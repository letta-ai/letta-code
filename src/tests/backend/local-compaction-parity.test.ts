import { describe, expect, test } from "bun:test";
import {
  formatLocalMessagesForSummary,
  type LocalCompactionStats,
  packageLocalSummaryMessage,
} from "../../backend/local/compaction";
import type { LocalMessage } from "../../backend/local/LocalMessage";

function message(message: LocalMessage): LocalMessage {
  return message;
}

describe("local compaction API parity", () => {
  test("formats local messages with the API simple_formatter transcript contract", () => {
    const transcript = formatLocalMessagesForSummary([
      message({
        id: "sys-1",
        role: "system",
        parts: [{ type: "text", text: "system prompt is excluded" }],
      } as LocalMessage),
      message({
        id: "user-1",
        role: "user",
        parts: [
          { type: "text", text: "Please inspect this screenshot." },
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
            filename: "screenshot.png",
          },
        ],
      } as LocalMessage),
      message({
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "I should inspect the directory first." },
          {
            type: "tool-ShellCommand",
            toolCallId: "call-shell",
            state: "output-available",
            input: { command: "ls", workdir: "/repo" },
            output: "README.md\nsrc",
          },
          { type: "text", text: "The repo has source and docs." },
        ],
      } as LocalMessage),
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
        message({
          id: "assistant-tool",
          role: "assistant",
          parts: [
            {
              type: "tool-ShellCommand",
              toolCallId: "call-big",
              state: "output-available",
              input: { command: "cat huge.log" },
              output: `${"x".repeat(12)}END`,
            },
          ],
        } as LocalMessage),
      ],
      { truncationChars: 10 },
    );

    expect(transcript).toBe(
      ' \n[assistant] -> ShellCommand({"command":"cat huge.log"})\n[tool] xxxxxxxxxx... [truncated 5 chars]\n \n. Generate the summary.',
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
      message({
        id: "summary-1",
        role: "user",
        metadata: {
          compaction: {
            summary: "raw recursive summary",
          },
        },
        parts: [{ type: "text", text: packedSummary }],
      } as LocalMessage),
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
