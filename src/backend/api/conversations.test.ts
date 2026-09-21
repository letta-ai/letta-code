import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkConversation } from "@/backend/api/conversations";
import { settingsManager } from "@/settings-manager";

describe("conversation API requests", () => {
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

  test("fork metadata is sent in the body while snapshot selectors remain query parameters", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        expect(request.method).toBe("POST");
        expect(url.pathname).toBe("/v1/conversations/default/fork");
        expect(url.searchParams.get("agent_id")).toBe("agent-parent");
        expect(url.searchParams.get("message_id")).toBe("message-boundary");
        expect(url.searchParams.has("hidden")).toBe(false);
        expect(await request.json()).toEqual({
          ephemeral: true,
          name: "Reviewer (Parent's shadow)",
          is_subagent: true,
        });
        return Response.json({ id: "conv-fork" });
      },
    });
    const originalUrl = process.env.LETTA_BASE_URL;
    process.env.LETTA_BASE_URL = server.url.toString().replace(/\/$/, "");
    try {
      expect(
        await forkConversation("default", {
          agentId: "agent-parent",
          messageId: "message-boundary",
          ephemeral: true,
          name: "Reviewer (Parent's shadow)",
          isSubagent: true,
        }),
      ).toEqual({ id: "conv-fork" });
    } finally {
      if (originalUrl === undefined) delete process.env.LETTA_BASE_URL;
      else process.env.LETTA_BASE_URL = originalUrl;
      server.stop(true);
    }
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
