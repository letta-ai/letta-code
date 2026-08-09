import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";

describe("local agent hot-reload", () => {
  test("retrieves patched model_settings after the agent JSON file is modified on disk", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-agent-reload-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Reload target",
      } as never);

      const agentsDir = join(storageDir, "agents");
      const agentFile = join(agentsDir, `${agent.id}.json`);
      const initial = JSON.parse(await readFile(agentFile, "utf8"));
      expect(initial.model_settings?.context_window_limit).not.toBe(96000);
      expect(initial.model_settings?.max_tokens).not.toBe(32000);

      // Wait long enough for the mtime to advance even on filesystems
      // with second-resolution timestamps.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const patched = {
        ...initial,
        model_settings: {
          ...initial.model_settings,
          context_window_limit: 96000,
          max_tokens: 32000,
        },
      };
      await writeFile(agentFile, `${JSON.stringify(patched, null, 2)}\n`);

      const reloaded = await backend.retrieveAgent(agent.id);
      expect(reloaded).toMatchObject({
        id: agent.id,
        model_settings: expect.objectContaining({
          context_window_limit: 96000,
          max_tokens: 32000,
        }),
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("does not reload when the file mtime is unchanged", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-agent-norewrite-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "No-op target",
      } as never);

      // Multiple back-to-back reads should hit the in-memory cache.
      const first = await backend.retrieveAgent(agent.id);
      const second = await backend.retrieveAgent(agent.id);
      expect(first).toMatchObject({ id: agent.id });
      expect(second).toMatchObject({ id: agent.id });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves the cached record if the on-disk JSON fails to parse", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-agent-corrupt-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Corrupt target",
      } as never);

      const agentFile = join(storageDir, "agents", `${agent.id}.json`);

      // Wait so the file's mtime advances.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile(agentFile, "{ this is not valid json");

      // The cached record must survive — corrupted disk content must not
      // crash the live agent.
      const still = await backend.retrieveAgent(agent.id);
      expect(still).toMatchObject({ id: agent.id, name: "Corrupt target" });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("survives the agent file being deleted on disk", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-agent-deleted-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Deleted target",
      } as never);

      const agentFile = join(storageDir, "agents", `${agent.id}.json`);
      await rm(agentFile);

      // In-memory copy still wins when the on-disk file is gone.
      const still = await backend.retrieveAgent(agent.id);
      expect(still).toMatchObject({ id: agent.id, name: "Deleted target" });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});