import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@/backend/local/local-store";

describe("LocalStore lazy system-prompt loading", () => {
  test("does not eagerly load system-prompt.json for all conversations during storage scan", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-store-lazy-prompt-"),
    );

    try {
      const store1 = new LocalStore("agent-default", { storageDir });
      const agent = store1.createAgent({ name: "PromptAgent" });
      const conv1 = store1.createConversation({ agent_id: agent.id });
      const conv2 = store1.createConversation({ agent_id: agent.id });
      const conv3 = store1.createConversation({ agent_id: agent.id });

      store1.setCompiledSystemPrompt(conv1.id, agent.id, {
        content: "compiled-prompt-1",
        compiledAt: "2026-11-20T00:00:00.000Z",
      } as never);
      store1.setCompiledSystemPrompt(conv2.id, agent.id, {
        content: "compiled-prompt-2",
        compiledAt: "2026-11-20T00:00:00.000Z",
      } as never);
      store1.setCompiledSystemPrompt(conv3.id, agent.id, {
        content: "compiled-prompt-3",
        compiledAt: "2026-11-20T00:00:00.000Z",
      } as never);

      // Reopen storage and trigger a full conversation scan (e.g. listConversations).
      const store2 = new LocalStore("agent-default", { storageDir });
      const listed = store2.listConversations({ agent_id: agent.id });
      expect(listed.length).toBeGreaterThanOrEqual(3);

      const promptMap = (
        store2 as unknown as {
          compiledSystemPromptByConversationKey: Map<string, unknown>;
        }
      ).compiledSystemPromptByConversationKey;
      // Scanning conversations must not eagerly load every system-prompt.json into memory.
      expect(promptMap.size).toBe(0);

      // Accessing a single conversation's compiled prompt loads only that one lazily.
      const loaded1 = store2.getCompiledSystemPrompt(conv1.id, agent.id);
      expect(loaded1?.content).toBe("compiled-prompt-1");
      expect(promptMap.size).toBe(1);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
