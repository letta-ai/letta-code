import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkConversation } from "@/backend/api/conversations";
import { settingsManager } from "@/settings-manager";

describe("conversation API requests", () => {
  test("puts ephemeral identity in the fork body and keeps existing query parameters", async () => {
    let captured: unknown[] = [];
    await forkConversation(
      "default",
      {
        agentId: "agent-parent",
        hidden: true,
        ephemeral: true,
        name: "Joi (subagent)",
        isSubagent: true,
      },
      async (...args) => {
        captured = args;
        return { id: "conv-child" } as never;
      },
    );
    expect(captured).toEqual([
      "POST",
      "/v1/conversations/default/fork",
      { ephemeral: true, name: "Joi (subagent)", is_subagent: true },
      { query: { agent_id: "agent-parent", hidden: true } },
    ]);
  });
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), "letta-conversation-api-test-"));
    process.env.HOME = testHome;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  test("stops a fork request when its Agent turn is interrupted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      forkConversation("conv-parent", {
        hidden: true,
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
