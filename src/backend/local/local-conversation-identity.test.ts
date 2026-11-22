import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import { LocalBackend } from "./local-backend";

describe("persistent local conversation identity", () => {
  let directory: string;
  let storageDir: string;
  let previousConfigDir: string | undefined;
  let backend: LocalBackend;
  let agentId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "letta-conversation-identity-"));
    storageDir = join(directory, "backend");
    previousConfigDir = process.env.LETTA_CONFIG_DIR;
    process.env.LETTA_CONFIG_DIR = join(directory, "config");
    await settingsManager.reset();
    await settingsManager.initialize();
    backend = new LocalBackend({ storageDir, memfsEnabled: false });
    agentId = (await backend.createAgent({ name: "identity-fixture" })).id;
  });

  afterEach(async () => {
    await settingsManager.reset();
    if (previousConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previousConfigDir;
    await rm(directory, { recursive: true, force: true });
  });

  test("a new fork cannot reuse a deleted fork's identity after restart", async () => {
    const source = await backend.createConversation({ agent_id: agentId });
    const original = await backend.forkConversation(source.id, { agentId });
    const conversationsDir = join(storageDir, "conversations");
    for (const entry of await readdir(conversationsDir)) {
      const path = join(conversationsDir, entry);
      const record = JSON.parse(
        await readFile(join(path, "conversation.json"), "utf8"),
      ) as { id: string };
      if (record.id === original.id)
        await rm(path, { recursive: true, force: true });
    }
    const restarted = new LocalBackend({ storageDir, memfsEnabled: false });
    const replacement = await restarted.forkConversation(source.id, {
      agentId,
    });
    expect(replacement.id).not.toBe(original.id);
    await expect(restarted.retrieveConversation(original.id)).rejects.toThrow();
    expect((await restarted.retrieveConversation(source.id)).agent_id).toBe(
      agentId,
    );
  });

  test("creation and forks stay distinct across backend instances while old IDs remain readable", async () => {
    const first = await backend.createConversation({ agent_id: agentId });
    const firstFork = await backend.forkConversation(first.id, { agentId });
    const restarted = new LocalBackend({ storageDir, memfsEnabled: false });
    const second = await restarted.createConversation({ agent_id: agentId });
    const secondFork = await restarted.forkConversation(first.id, { agentId });
    expect(
      new Set([first.id, firstFork.id, second.id, secondFork.id]).size,
    ).toBe(4);
    for (const id of [first.id, firstFork.id, second.id, secondFork.id]) {
      expect((await restarted.retrieveConversation(id)).agent_id).toBe(agentId);
    }
  });
});
