import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkConversation } from "@/backend/api/conversations";
import { createEphemeralConversation } from "@/backend/api/ephemeral-conversations";
import { settingsManager } from "@/settings-manager";
import { removeTestDir } from "@/test-utils/test-fs";

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
    await removeTestDir(testHome);
    process.env.HOME = originalHome;
  });

  test("ephemeral launches send their preset and preserve server refusals", async () => {
    const originalBase = process.env.LETTA_BASE_URL;
    const originalType = process.env.LETTA_CODE_SUBAGENT_TYPE;
    const received: Array<string | null> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        received.push(request.headers.get("x-letta-subagent-type"));
        return Response.json(
          {
            error:
              "Daily subagent limit reached; use a connected coding agent.",
          },
          { status: 403 },
        );
      },
    });
    process.env.LETTA_BASE_URL = String(server.url).replace(/\/$/, "");
    process.env.LETTA_CODE_SUBAGENT_TYPE = "reflection";
    try {
      await expect(
        createEphemeralConversation({
          model: "letta/auto",
          system: "test",
          is_subagent: true,
        }),
      ).rejects.toThrow("Daily subagent limit reached");
      await expect(
        createEphemeralConversation({ model: "letta/auto", system: "test" }),
      ).rejects.toThrow("Daily subagent limit reached");
      expect(received).toEqual(["reflection", null]);
    } finally {
      if (originalBase === undefined) delete process.env.LETTA_BASE_URL;
      else process.env.LETTA_BASE_URL = originalBase;
      if (originalType === undefined)
        delete process.env.LETTA_CODE_SUBAGENT_TYPE;
      else process.env.LETTA_CODE_SUBAGENT_TYPE = originalType;
      await server.stop(true);
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
