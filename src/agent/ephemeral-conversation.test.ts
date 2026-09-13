import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEphemeralConversationCreateBody,
  createLocalEphemeralConversation,
} from "@/agent/ephemeral-conversation";
import {
  configureBackendMode,
  configureEphemeralLocalBackend,
} from "@/backend";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();
describe("ephemeral conversation creation", () => {
  afterEach(() => {
    configureBackendMode("api");
  });

  test("builds execution state without agent memory or tags", async () => {
    const body = await buildEphemeralConversationCreateBody({
      model: "gpt-5.6-luna",
      systemPromptCustom: "isolated prompt",
    });

    expect(body.model).toBe("openai/gpt-5.6-luna");
    expect(body.system).toBe("isolated prompt");
    expect(body.context_window_limit).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("tags");
    expect(body).not.toHaveProperty("memory_blocks");
  });

  test("creates local execution state outside the persistent local store", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "letta-local-persistent-"));
    const originalStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    try {
      configureBackendMode("local");
      configureEphemeralLocalBackend();
      const result = await createLocalEphemeralConversation({
        model: "openai/gpt-5-mini",
        systemPromptCustom: "isolated local prompt",
      });

      expect(result.agent.id).toStartWith("agent-local-");
      expect(result.conversationId).toStartWith("local-conv-");
      expect(existsSync(join(storageDir, "agents"))).toBe(false);
      expect(existsSync(join(storageDir, "conversations"))).toBe(false);
      expect(existsSync(join(storageDir, "memfs"))).toBe(false);
    } finally {
      if (originalStorageDir === undefined) {
        delete process.env.LETTA_LOCAL_BACKEND_DIR;
      } else {
        process.env.LETTA_LOCAL_BACKEND_DIR = originalStorageDir;
      }
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
