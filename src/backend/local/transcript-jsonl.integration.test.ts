import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

function pageItems<T>(value: T[] | { getPaginatedItems(): T[] }): T[] {
  return Array.isArray(value) ? value : value.getPaginatedItems();
}

function conversationDirectory(
  storageDir: string,
  conversationId: string,
): string {
  const key = Buffer.from(`conversation:${conversationId}`).toString(
    "base64url",
  );
  return join(storageDir, "conversations", key);
}

describe("local transcript JSONL recovery", () => {
  test("loads history and preserves a damaged tail before the next append", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-partial-tail-"),
    );
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      await drain(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "durable transcript message" }],
        } as ConversationMessageCreateBody),
      );

      const conversationDir = conversationDirectory(
        storageDir,
        conversation.id,
      );
      await appendFile(
        join(conversationDir, "messages.jsonl"),
        '{"id":"partial"',
      );

      const reloaded = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
        memfsEnabled: false,
      });
      const recoveredMessages = pageItems(
        await reloaded.listConversationMessages(conversation.id, {
          agent_id: agent.id,
          order: "asc",
        } as never),
      );
      expect(JSON.stringify(recoveredMessages)).toContain(
        "durable transcript message",
      );

      await drain(
        await reloaded.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "message after recovery" }],
        } as ConversationMessageCreateBody),
      );
      const backupName = (await readdir(conversationDir)).find((name) =>
        name.startsWith("messages.jsonl.corrupt-tail-backup-"),
      );
      expect(backupName).toBeString();
      expect(
        await readFile(join(conversationDir, backupName ?? ""), "utf8"),
      ).toEndWith('{"id":"partial"');

      const reloadedAfterRepair = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
        memfsEnabled: false,
      });
      const repairedMessages = pageItems(
        await reloadedAfterRepair.listConversationMessages(conversation.id, {
          agent_id: agent.id,
          order: "asc",
        } as never),
      );
      expect(JSON.stringify(repairedMessages)).toContain(
        "durable transcript message",
      );
      expect(JSON.stringify(repairedMessages)).toContain(
        "message after recovery",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
