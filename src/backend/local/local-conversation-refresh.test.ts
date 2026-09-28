import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local conversation refresh", () => {
  test.each(["different byte length", "same byte length"])(
    "reloads external compaction with unchanged mtime and %s",
    async (sizeCase) => {
      const sameByteLength = sizeCase === "same byte length";
      const storageDir = await mkdtemp(join(tmpdir(), "local-record-refresh-"));
      temporaryDirectories.push(storageDir);
      const agentId = "agent-local-external-compact";
      const writer = new LocalStore(agentId, {
        storageDir,
        residentMessageTailLimit: 100,
      });
      for (let turn = 0; turn < 6; turn += 1) {
        writer.appendTurnInput("default", {
          agent_id: agentId,
          messages: [{ role: "user", content: `turn-${turn}` }],
        });
        writer.appendStreamChunk("default", agentId, {
          message_type: "assistant_message",
          id: `provider-${turn}`,
          date: "2026-01-01T00:00:00Z",
          content: [{ type: "text", text: `reply: turn-${turn}` }],
        });
        writer.appendStreamChunk("default", agentId, {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        });
      }
      const remainingMessages = writer
        .listLocalMessages("default", agentId)
        .slice(-4);
      const compact = () =>
        writer.compactConversationAll({
          conversationId: "default",
          agentId,
          summary: "summary text",
          packedSummary: "packed summary",
          remainingMessages,
        });
      // A second compaction replaces ui-msg-13 with ui-msg-14, preserving
      // both the active message count and the serialized record's byte length.
      if (sameByteLength) compact();
      const recordPath = join(
        storageDir,
        "conversations",
        Buffer.from(`default:${agentId}`).toString("base64url"),
        "conversation.json",
      );
      const timestamp = new Date("2026-01-01T00:00:00Z");
      await utimes(recordPath, timestamp, timestamp);
      const reader = new LocalStore(agentId, {
        storageDir,
        residentMessageTailLimit: 100,
      });
      const before = reader.listLocalMessages("default", agentId);
      const beforeStat = await stat(recordPath);

      const result = compact();
      await utimes(recordPath, timestamp, timestamp);
      const afterStat = await stat(recordPath);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
      expect(afterStat.size === beforeStat.size).toBe(sameByteLength);

      const messages = reader.listLocalMessages("default", agentId);
      expect(messages[0]?.id).toBe(result.summaryMessage.id);
      expect(messages).toHaveLength(5);
      expect(messages.some((message) => message.id === before[0]?.id)).toBe(
        false,
      );
    },
  );
});
