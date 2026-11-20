import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  LocalBackendNotFoundError,
  LocalStore,
} from "@/backend/local/local-store";

const executor: HeadlessTurnExecutor = {
  async execute() {
    return createAssistantMessageStream({
      content: [{ type: "text", text: "ok" }],
    });
  },
};

function conversationDirCount(root: string): number {
  const dir = join(root, "conversations");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

function withTempDir(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "local-conversation-delete-"));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("local conversation deletion", () => {
  test(
    "removes the conversation directory and its listing",
    withTempDir((root) => {
      const agentId = "agent-local-delete";
      const store = new LocalStore(agentId, {
        storageDir: root,
        strictConversationAccess: true,
      });
      const kept = store.createConversation({ agent_id: agentId } as never);
      const doomed = store.createConversation({ agent_id: agentId } as never);
      const dirsBefore = conversationDirCount(root);

      store.deleteConversation(doomed.id);

      expect(conversationDirCount(root)).toBe(dirsBefore - 1);
      const listed = store
        .listConversations({ agent_id: agentId } as never)
        .map((conversation) => conversation.id);
      expect(listed).toContain(kept.id);
      expect(listed).not.toContain(doomed.id);
      expect(() => store.retrieveConversation(doomed.id)).toThrow(
        LocalBackendNotFoundError,
      );

      const reloaded = new LocalStore(agentId, {
        storageDir: root,
        strictConversationAccess: true,
      });
      expect(() => reloaded.retrieveConversation(doomed.id)).toThrow(
        LocalBackendNotFoundError,
      );
    }),
  );

  test(
    "removes an agent-free ephemeral conversation",
    withTempDir((root) => {
      const store = new LocalStore("agent-local-parent", { storageDir: root });
      const dirsBefore = conversationDirCount(root);
      const created = store.createEphemeralConversation({
        model: "openai/gpt-5.6-luna",
        system: "worker system",
      });
      expect(conversationDirCount(root)).toBe(dirsBefore + 1);

      store.deleteConversation(created.id);

      expect(conversationDirCount(root)).toBe(dirsBefore);
      expect(store.isAgentFreeConversation(created.id)).toBe(false);
    }),
  );

  test("refuses unknown ids", () => {
    const store = new LocalStore("agent-local-unknown-delete", {
      strictConversationAccess: true,
    });
    expect(() => store.deleteConversation("local-conv-missing")).toThrow(
      LocalBackendNotFoundError,
    );
  });

  test(
    "backend refuses a conversation with an active run",
    withTempDir(async (root) => {
      const backend = new LocalBackend({
        storageDir: root,
        executor,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({ name: "deleter" } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);

      // Not consuming the stream leaves the run non-terminal.
      const stream = await backend.createConversationMessageStream(
        conversation.id,
        {
          agent_id: agent.id,
          messages: [{ role: "user", content: "hi" }],
        } as never,
      );

      await expect(backend.deleteConversation(conversation.id)).rejects.toThrow(
        /while it has an active run/,
      );
      await expect(backend.deleteConversation("default")).rejects.toThrow(
        "default conversation cannot be deleted",
      );

      for await (const _chunk of stream) {
        // Drain to a stop reason so the run completes.
      }
      await backend.deleteConversation(conversation.id);
      await expect(
        backend.retrieveConversation(conversation.id),
      ).rejects.toThrow(LocalBackendNotFoundError);
    }),
  );
});
