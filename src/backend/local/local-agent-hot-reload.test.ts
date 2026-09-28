import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubagentSecretEnv } from "@/agent/subagents/subagent-launcher";
import { applySecretBatch, clearSecretsCache } from "@/utils/secrets-store";
import { LocalStore } from "./local-store";
import type { LocalAgentRecord } from "./local-types";

interface AgentFixture {
  agentId: string;
  agentFile: string;
  storageDir: string;
  store: LocalStore;
}

function createStore(storageDir: string): LocalStore {
  return new LocalStore("agent-local-default", {
    storageDir,
    seedDefaultAgent: false,
    strictAgentAccess: true,
    strictConversationAccess: true,
  });
}

async function createAgentFixture(): Promise<AgentFixture> {
  const storageDir = await mkdtemp(join(tmpdir(), "local-agent-hot-reload-"));
  const store = createStore(storageDir);
  const agent = store.createAgent({ name: "Reload target" } as never);
  const agentsDir = join(storageDir, "agents");
  const agentFiles = (await readdir(agentsDir)).filter((file) =>
    file.endsWith(".json"),
  );
  expect(agentFiles).toHaveLength(1);
  const agentFile = agentFiles[0];
  if (!agentFile) throw new Error("Expected one persisted agent record");
  return {
    agentId: agent.id,
    agentFile: join(agentsDir, agentFile),
    storageDir,
    store,
  };
}

async function readAgentRecord(agentFile: string): Promise<LocalAgentRecord> {
  return JSON.parse(await readFile(agentFile, "utf8")) as LocalAgentRecord;
}

async function writeChangedAgentFile(
  agentFile: string,
  contents: string,
): Promise<void> {
  const previousMtimeMs = (await stat(agentFile)).mtimeMs;
  await writeFile(agentFile, contents);
  const changedAt = new Date(Math.ceil(previousMtimeMs) + 2_000);
  await utimes(agentFile, changedAt, changedAt);
}

async function patchAgentFile(
  agentFile: string,
  patch: (record: LocalAgentRecord) => LocalAgentRecord,
): Promise<LocalAgentRecord> {
  const updated = patch(await readAgentRecord(agentFile));
  await writeChangedAgentFile(
    agentFile,
    `${JSON.stringify(updated, null, 2)}\n`,
  );
  return updated;
}

describe("local agent hot-reload", () => {
  test("refreshes public retrieval and listings after an external edit", async () => {
    const fixture = await createAgentFixture();
    try {
      await patchAgentFile(fixture.agentFile, (record) => ({
        ...record,
        name: "Externally renamed",
        model_settings: {
          ...record.model_settings,
          context_window_limit: 96_000,
        },
      }));

      expect(fixture.store.retrieveAgent(fixture.agentId)).toMatchObject({
        name: "Externally renamed",
        model_settings: { context_window_limit: 96_000 },
      });

      await patchAgentFile(fixture.agentFile, (record) => ({
        ...record,
        name: "Renamed again",
      }));
      expect(fixture.store.listAgents().items).toEqual([
        expect.objectContaining({
          id: fixture.agentId,
          name: "Renamed again",
        }),
      ]);
    } finally {
      await rm(fixture.storageDir, { recursive: true, force: true });
    }
  });

  test("refreshes the agent record used to start turns", async () => {
    const fixture = await createAgentFixture();
    try {
      await patchAgentFile(fixture.agentFile, (record) => ({
        ...record,
        model_settings: {
          ...record.model_settings,
          max_tokens: 32_000,
        },
      }));

      expect(
        fixture.store.retrieveAgentRecord(fixture.agentId).model_settings,
      ).toMatchObject({ max_tokens: 32_000 });
    } finally {
      await rm(fixture.storageDir, { recursive: true, force: true });
    }
  });

  test("refreshes records loaded by a new store instance", async () => {
    const fixture = await createAgentFixture();
    try {
      const reloadedStore = createStore(fixture.storageDir);
      await patchAgentFile(fixture.agentFile, (record) => ({
        ...record,
        name: "Changed after reload",
      }));

      expect(reloadedStore.retrieveAgent(fixture.agentId).name).toBe(
        "Changed after reload",
      );
    } finally {
      await rm(fixture.storageDir, { recursive: true, force: true });
    }
  });

  test("preserves external edits when an API update writes the agent", async () => {
    const fixture = await createAgentFixture();
    try {
      await patchAgentFile(fixture.agentFile, (record) => ({
        ...record,
        system: "Externally edited system prompt",
        model_settings: {
          ...record.model_settings,
          context_window_limit: 96_000,
        },
      }));

      const updated = fixture.store.updateAgent(fixture.agentId, {
        name: "API rename",
      } as never);
      expect(updated).toMatchObject({
        name: "API rename",
        system: "Externally edited system prompt",
        model_settings: { context_window_limit: 96_000 },
      });
      expect(await readAgentRecord(fixture.agentFile)).toMatchObject({
        name: "API rename",
        system: "Externally edited system prompt",
        model_settings: { context_window_limit: 96_000 },
      });
    } finally {
      await rm(fixture.storageDir, { recursive: true, force: true });
    }
  });

  test("preserves external edits when compaction settings are written", async () => {
    const fixture = await createAgentFixture();
    try {
      await patchAgentFile(fixture.agentFile, (record) => ({
        ...record,
        system: "Externally edited system prompt",
      }));

      const updated = fixture.store.setAgentCompactionSettings(
        fixture.agentId,
        { mode: "sliding_window" },
      );
      expect(updated).toMatchObject({
        system: "Externally edited system prompt",
        compaction_settings: { mode: "sliding_window" },
      });
      expect(await readAgentRecord(fixture.agentFile)).toMatchObject({
        system: "Externally edited system prompt",
        compaction_settings: { mode: "sliding_window" },
      });
    } finally {
      await rm(fixture.storageDir, { recursive: true, force: true });
    }
  });

  test("persists hidden child parent and authorizes only its own conversation on resume", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-child-lineage-"));
    const previousDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
    try {
      const store = createStore(storageDir);
      const parent = store.createAgent({ name: "Parent" } as never);
      await applySecretBatch(
        { set: { CHILD_CANARY: "local-fixture" } },
        parent.id,
      );
      const child = store.createAgent({
        name: "Child",
        hidden: true,
        parent_agent_id: parent.id,
      } as never);
      const legacy = store.createAgent({
        name: "Legacy",
        hidden: true,
      } as never);
      const unrelated = store.createAgent({ name: "Other" } as never);
      const childConversation = store.createConversation({
        agent_id: child.id,
      } as never);
      const otherConversation = store.createConversation({
        agent_id: unrelated.id,
      } as never);
      const reloaded = createStore(storageDir);
      const retrieveAgent = async (id: string) => reloaded.retrieveAgent(id);
      const retrieveConversation = async (id: string) =>
        reloaded.retrieveConversation(id);
      const resolve = (agentId: string, conversationId: string) =>
        resolveSubagentSecretEnv({
          parentAgentId: parent.id,
          existingAgentId: agentId,
          existingConversationId: conversationId,
          localBackend: true,
          retrieveAgent,
          retrieveConversation,
        });
      expect(reloaded.retrieveAgent(child.id)).toMatchObject({
        parent_agent_id: parent.id,
      });
      expect(await resolve(child.id, childConversation.id)).toEqual({
        CHILD_CANARY: "local-fixture",
      });
      expect(await resolve(child.id, otherConversation.id)).toEqual({});
      expect(await resolve(legacy.id, childConversation.id)).toEqual({});
      expect(
        await resolveSubagentSecretEnv({
          parentAgentId: unrelated.id,
          existingAgentId: child.id,
          existingConversationId: childConversation.id,
          localBackend: true,
          retrieveAgent,
          retrieveConversation,
        }),
      ).toEqual({});
      expect(await resolve(unrelated.id, childConversation.id)).toEqual({});
      expect(await resolve(child.id, "default")).toEqual({
        CHILD_CANARY: "local-fixture",
      });
      expect(
        await resolveSubagentSecretEnv({
          parentAgentId: parent.id,
          existingAgentId: child.id,
          localBackend: true,
          retrieveAgent,
          retrieveConversation,
        }),
      ).toEqual({ CHILD_CANARY: "local-fixture" });
    } finally {
      clearSecretsCache(null);
      if (previousDir === undefined) delete process.env.LETTA_LOCAL_BACKEND_DIR;
      else process.env.LETTA_LOCAL_BACKEND_DIR = previousDir;
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("keeps the cached record through malformed or missing files", async () => {
    const fixture = await createAgentFixture();
    try {
      const original = await readAgentRecord(fixture.agentFile);
      await writeChangedAgentFile(fixture.agentFile, "{ invalid json");
      expect(fixture.store.retrieveAgent(fixture.agentId).name).toBe(
        "Reload target",
      );

      const recovered = {
        ...original,
        name: "Recovered record",
      };
      await writeChangedAgentFile(
        fixture.agentFile,
        `${JSON.stringify(recovered, null, 2)}\n`,
      );
      expect(fixture.store.retrieveAgent(fixture.agentId).name).toBe(
        "Recovered record",
      );

      await rm(fixture.agentFile);
      expect(fixture.store.retrieveAgent(fixture.agentId).name).toBe(
        "Recovered record",
      );
    } finally {
      await rm(fixture.storageDir, { recursive: true, force: true });
    }
  });
});
