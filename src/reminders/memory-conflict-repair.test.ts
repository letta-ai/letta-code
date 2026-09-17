import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMemoryConflictSummary,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { isMemoryRepairActive } from "@/agent/memory-repair-state";
import { __testSetBackend, type Backend } from "@/backend";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import { startMemoryConflictRepair } from "./memory-conflict-repair";
import { runPostTurnMemorySync } from "./memory-git-sync";

const roots: string[] = [];
afterEach(() => {
  __testSetBackend(null);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const memoryDir = mkdtempSync(join(tmpdir(), "memory-conflict-repair-"));
  roots.push(memoryDir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", memoryDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-b", "main");
  git("config", "user.name", "Memory Test");
  git("config", "user.email", "memory@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(memoryDir, "note.md"), "original\n");
  git("add", "note.md");
  git("commit", "-m", "initial");
  git("checkout", "-b", "other");
  writeFileSync(join(memoryDir, "note.md"), "other memory\n");
  git("commit", "-am", "other");
  git("checkout", "main");
  writeFileSync(join(memoryDir, "note.md"), "primary memory\n");
  git("commit", "-am", "primary");
  expect(() => git("merge", "other")).toThrow();

  const created: unknown[] = [];
  __testSetBackend({
    capabilities: { localMemfs: true, remoteMemfs: false },
    createConversation: async (body: unknown) => {
      created.push(body);
      return { id: "conv-repair" };
    },
  } as unknown as Backend);
  const jobs: SpawnBackgroundSubagentTaskArgs[] = [];
  const spawn = (args: SpawnBackgroundSubagentTaskArgs) => {
    jobs.push(args);
  };
  const syncMemory = (agentId: string) =>
    syncPendingMemoryCommitsAfterTurn(agentId, { memoryDir });
  const repairConflict: typeof startMemoryConflictRepair = (params) =>
    startMemoryConflictRepair(params, { spawn, syncMemory });
  const dependencies = {
    syncMemory,
    repairConflict,
    isRepairActive: () => isMemoryRepairActive(memoryDir),
    syncAttachedRepositories: async () => ({ results: [] }),
  };
  const reminders: string[] = [];
  const turn = () =>
    runPostTurnMemorySync(
      {
        agentId: "agent-primary",
        conversationId: "conv-original",
        enqueueReminder: (text) => {
          reminders.push(text);
        },
      },
      dependencies,
    );
  const finish = async (success = true) => {
    const job = jobs.at(-1);
    if (!job?.onComplete) throw new Error("No repair running");
    await job.onComplete({ success, conversationId: "conv-repair" });
  };
  const resolve = () => {
    writeFileSync(join(memoryDir, "note.md"), "primary and other memory\n");
    git("add", "note.md");
    git("commit", "-m", "resolve memory conflict");
  };
  return {
    memoryDir,
    git,
    created,
    jobs,
    spawn,
    syncMemory,
    dependencies,
    reminders,
    turn,
    finish,
    resolve,
  };
}

test("repairs a real conflict in a hidden same-agent conversation without parent reminders", async () => {
  const f = fixture();
  await f.turn();
  expect(f.created).toEqual([
    {
      agent_id: "agent-primary",
      hidden: true,
      summary: "Memory conflict repair",
    },
  ]);
  expect(f.jobs).toHaveLength(1);
  expect(f.jobs[0]).toMatchObject({
    existingAgentId: "agent-primary",
    existingConversationId: "conv-repair",
    parentScope: { agentId: "agent-primary", conversationId: "conv-original" },
    silentCompletion: true,
    maxTurns: 20,
    memoryScope: { primaryRoot: f.memoryDir, writableRoots: [f.memoryDir] },
  });
  expect(f.jobs[0]?.prompt).toContain("note.md");
  expect(f.reminders).toEqual([]);
  expect(await isMemoryRepairActive(f.memoryDir)).toBe(true);
  await f.turn();
  expect(f.jobs).toHaveLength(1);
  f.resolve();
  await f.finish();
  expect(await getMemoryConflictSummary(f.memoryDir)).toBeNull();
  expect(await isMemoryRepairActive(f.memoryDir)).toBe(false);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.reminders).toEqual([]);
});

test("concurrent launch attempts acquire only one repository claim", async () => {
  const f = fixture();
  const result = await f.syncMemory("agent-primary");
  await Promise.all(
    [1, 2, 3].map(() =>
      startMemoryConflictRepair(
        { agentId: "agent-primary", result },
        { spawn: f.spawn },
      ),
    ),
  );
  expect(f.created).toHaveLength(1);
  expect(f.jobs).toHaveLength(1);
  await f.finish(false);
});

test("an unresolved conflict stays out of the parent and backs off even after reported success", async () => {
  const f = fixture();
  await f.turn();
  await f.finish(true);
  expect(await getMemoryConflictSummary(f.memoryDir)).toContain("note.md");
  expect(await isMemoryRepairActive(f.memoryDir)).toBe(false);
  await f.turn();
  expect(f.jobs).toHaveLength(1);
  expect(f.reminders).toEqual([]);
  const state = JSON.parse(
    readFileSync(join(f.memoryDir, ".git", "letta-memory-repair.json"), "utf8"),
  );
  expect(state.retryAfter).toBeGreaterThan(Date.now());
});

test("launch failures release ownership and do not inject the conflict into the parent", async () => {
  const f = fixture();
  await runPostTurnMemorySync(
    {
      agentId: "agent-primary",
      enqueueReminder: (text) => {
        f.reminders.push(text);
      },
    },
    {
      ...f.dependencies,
      repairConflict: (params) =>
        startMemoryConflictRepair(params, {
          spawn: () => {
            throw new Error("capacity exceeded");
          },
        }),
    },
  );
  expect(await isMemoryRepairActive(f.memoryDir)).toBe(false);
  expect(f.reminders).toEqual([]);
  await f.turn();
  expect(f.jobs).toHaveLength(0);
});

test("stale conflict reports do not create a repair conversation", async () => {
  const f = fixture();
  const result = await f.syncMemory("agent-primary");
  f.resolve();
  await startMemoryConflictRepair(
    { agentId: "agent-primary", result },
    { spawn: f.spawn },
  );
  expect(f.created).toEqual([]);
  expect(await isMemoryRepairActive(f.memoryDir)).toBe(false);
});

test("one-shot mode waits for verification before allowing the host to exit", async () => {
  const f = fixture();
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished = false;
  const completion = startMemoryConflictRepair(
    {
      agentId: "agent-primary",
      result: await f.syncMemory("agent-primary"),
      waitForCompletion: true,
    },
    {
      spawn: (args) => {
        f.spawn(args);
        started();
      },
    },
  ).then(() => {
    finished = true;
  });
  await ready;
  expect(finished).toBe(false);
  f.resolve();
  await f.finish();
  await completion;
  expect(finished).toBe(true);
  expect(await isMemoryRepairActive(f.memoryDir)).toBe(false);
});

test("unrelated dirty files are preserved and do not cause a second repair", async () => {
  const f = fixture();
  await f.turn();
  writeFileSync(join(f.memoryDir, "unrelated.md"), "in progress\n");
  await f.turn();
  expect(f.reminders).toEqual([]);
  f.resolve();
  await f.finish();
  expect(readFileSync(join(f.memoryDir, "unrelated.md"), "utf8")).toBe(
    "in progress\n",
  );
  expect(await getMemoryConflictSummary(f.memoryDir)).toBeNull();
  expect(f.jobs).toHaveLength(1);
});
