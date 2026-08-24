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
