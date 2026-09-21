import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalStore } from "@/backend/local/local-store";
import { turnInputMessageForLocalAppend } from "@/backend/local/local-turn-input";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-turn-input-"));
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

describe("turnInputMessageForLocalAppend", () => {
  test("passes user-role messages through unchanged", () => {
    const message = {
      type: "message",
      role: "user",
      content: "hello",
    };
    expect(turnInputMessageForLocalAppend(message)).toBe(message);
  });

  test("normalizes system-role string content into a user system-reminder", () => {
    const normalized = turnInputMessageForLocalAppend({
      type: "message",
      role: "system",
      content: '<emotions version="2">calm</emotions>',
    });

    expect(normalized).toEqual({
      type: "message",
      role: "user",
      content:
        '<system-reminder>\n<emotions version="2">calm</emotions>\n</system-reminder>',
    });
  });

  test("wraps text parts of system-role array content", () => {
    const normalized = turnInputMessageForLocalAppend({
      type: "message",
      role: "system",
      content: [
        { type: "text", text: "first" },
        { type: "image", source: { type: "base64" } },
        { type: "text", text: "second" },
      ],
    });

    expect(normalized?.role).toBe("user");
    expect(normalized?.content).toEqual([
      {
        type: "text",
        text: "<system-reminder>\nfirst\n</system-reminder>",
      },
      { type: "image", source: { type: "base64" } },
      {
        type: "text",
        text: "<system-reminder>\nsecond\n</system-reminder>",
      },
    ]);
  });

  test("drops roles the local message model cannot persist", () => {
    expect(
      turnInputMessageForLocalAppend({
        type: "message",
        role: "assistant",
        content: "hi",
      }),
    ).toBeNull();
    expect(
      turnInputMessageForLocalAppend({
        type: "message",
        role: "tool",
        content: "result",
      }),
    ).toBeNull();
  });
});

describe("LocalStore.appendTurnInput system-role ingestion", () => {
  test("persists system-role turn input as a user system-reminder message", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-system-turn-input";
    const store = new LocalStore(agentId, { storageDir });

    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [
        { type: "message", role: "user", content: "hello" },
        {
          type: "message",
          role: "system",
          content: '<emotions version="2">calm</emotions>',
        },
      ],
    } as unknown as ConversationMessageCreateBody);

    const messages = store.listLocalMessages("default", agentId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("user");
    const reminder = messages[1]?.content[0];
    const reminderText =
      typeof reminder === "object" && reminder?.type === "text"
        ? reminder.text
        : "";
    expect(reminderText).toBe(
      '<system-reminder>\n<emotions version="2">calm</emotions>\n</system-reminder>',
    );

    // The normalized message survives a transcript reload.
    const reloaded = new LocalStore(agentId, { storageDir }).listLocalMessages(
      "default",
      agentId,
    );
    expect(reloaded).toHaveLength(2);
    expect(reloaded[1]?.role).toBe("user");
  });

  test("still ignores unsupported roles without failing the turn", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-unsupported-turn-input";
    const store = new LocalStore(agentId, { storageDir });

    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [
        { type: "message", role: "assistant", content: "spoofed" },
        { type: "message", role: "user", content: "hello" },
      ],
    } as unknown as ConversationMessageCreateBody);

    const messages = store.listLocalMessages("default", agentId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });
});
