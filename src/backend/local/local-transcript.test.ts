import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalMessage } from "@/backend/local/local-message";
import {
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  type LocalTranscriptRowsResult,
  overlayResidentLocalMessageSuffix,
  readLocalTranscriptTailWindow,
  restrictLocalTranscriptToResidentMessages,
} from "@/backend/local/local-transcript";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-transcript-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

function userMessage(id: string, text: string): LocalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as LocalMessage;
}

describe("readLocalTranscriptTailWindow", () => {
  test("stops once the suffix covers every in-context id", async () => {
    const storageDir = await createStorageDirectory();
    const messagesPath = join(storageDir, "messages.jsonl");
    const messageCount = 200;
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "conversation-compacted",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: storageDir,
      }),
    ];
    const messageIds: string[] = [];
    let parentId: string | null = null;
    for (let index = 0; index < messageCount; index += 1) {
      const messageId = `msg-${index}`;
      const entryId = `ent-${index}`;
      messageIds.push(messageId);
      lines.push(
        JSON.stringify({
          type: "message",
          id: entryId,
          parentId,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            id: messageId,
            role: index % 2 === 0 ? "user" : "assistant",
            content: [
              { type: "text", text: `payload-${index}-${"x".repeat(400)}` },
            ],
            timestamp: 0,
          },
        }),
      );
      parentId = entryId;
    }
    await writeFile(messagesPath, `${lines.join("\n")}\n`);

    const activeMessageIds = messageIds.slice(-5);
    const result = readLocalTranscriptTailWindow(
      messagesPath,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      activeMessageIds,
      100,
      storageDir,
      storageDir,
    );

    expect(result.reachedStart).toBe(false);
    expect(result.messages.map((message) => message.id)).toEqual(
      activeMessageIds,
    );
    expect(result.transcript.messageById.size).toBeLessThan(messageCount);
  });
});

describe("restrictLocalTranscriptToResidentMessages", () => {
  test("drops historical suffix rows from persist maps", () => {
    const resident = [userMessage("keep-a", "a"), userMessage("keep-b", "b")];
    const historical = userMessage("old", "old");
    const transcript: LocalTranscriptRowsResult = {
      messages: resident,
      entryIds: new Set(["e-old", "e-a", "e-b", "e-last"]),
      entryIdByMessageId: new Map([
        ["old", "e-old"],
        ["keep-a", "e-a"],
        ["keep-b", "e-b"],
      ]),
      messageById: new Map([
        ["old", historical],
        ["keep-a", resident[0] as LocalMessage],
        ["keep-b", resident[1] as LocalMessage],
      ]),
      lastEntryId: "e-last",
      sourceStartIndex: 0,
    };

    const restricted = restrictLocalTranscriptToResidentMessages(
      transcript,
      resident,
    );
    expect([...restricted.messageById.keys()]).toEqual(["keep-a", "keep-b"]);
    expect([...restricted.entryIdByMessageId.keys()]).toEqual([
      "keep-a",
      "keep-b",
    ]);
    expect(restricted.entryIds.has("e-old")).toBe(false);
    expect(restricted.entryIds.has("e-last")).toBe(true);
    expect(restricted.lastEntryId).toBe("e-last");
  });
});

describe("overlayResidentLocalMessageSuffix", () => {
  test("appends the in-flight assistant and ignores older resident-only ids", () => {
    const disk = [userMessage("d1", "disk-1"), userMessage("d2", "disk-2")];
    const resident = [
      userMessage("older", "should-not-lead-or-trail"),
      userMessage("d1", "resident-d1"),
      userMessage("d2", "resident-d2"),
      userMessage("in-flight", "IN_FLIGHT_ASSISTANT"),
    ];
    const persisted = new Set(["older", "d1", "d2"]);
    const merged = overlayResidentLocalMessageSuffix(
      disk,
      resident,
      (messageId) => persisted.has(messageId),
    );
    expect(merged.map((message) => message.id)).toEqual([
      "d1",
      "d2",
      "in-flight",
    ]);
    expect(merged[0]).toEqual(resident[1]);
    expect(JSON.stringify(merged)).toContain("IN_FLIGHT_ASSISTANT");
    expect(JSON.stringify(merged)).not.toContain("should-not-lead-or-trail");
  });
});
