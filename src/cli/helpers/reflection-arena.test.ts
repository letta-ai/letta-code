import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  finalizeReflectionArenaChoice,
  type ReflectionArenaRun,
  setReflectionArenaRootOverrideForTests,
} from "@/cli/helpers/reflection-arena";
import { telemetry } from "@/telemetry";

const execFile = promisify(execFileCb);

// The arena vote is a one-shot terminal event. The bug this guards against:
// the vote was queued but never flushed, so it was lost when the session ended
// before the next periodic flush. These tests assert the vote is tracked AND
// flushed immediately during finalize, and that the transcript payload is
// attached to the telemetry event.

type TrackedVote = Record<string, unknown>;

let trackSpy: ReturnType<typeof mock>;
let drainSpy: ReturnType<typeof mock>;
let originalTrack: unknown;
let originalDrain: unknown;
let arenaRoot: string;

beforeEach(async () => {
  const t = telemetry as unknown as {
    trackReflectionArenaVote: unknown;
    drain: unknown;
  };
  originalTrack = t.trackReflectionArenaVote;
  originalDrain = t.drain;
  trackSpy = mock(() => undefined);
  drainSpy = mock(async () => undefined);
  t.trackReflectionArenaVote = trackSpy;
  t.drain = drainSpy;

  // Redirect all arena persistence (run files + choice log) to a temp dir.
  arenaRoot = await mkdtemp(join(tmpdir(), "arena-root-"));
  setReflectionArenaRootOverrideForTests(arenaRoot);
});

afterEach(async () => {
  const t = telemetry as unknown as {
    trackReflectionArenaVote: unknown;
    drain: unknown;
  };
  t.trackReflectionArenaVote = originalTrack;
  t.drain = originalDrain;
  setReflectionArenaRootOverrideForTests(null);
  await rm(arenaRoot, { recursive: true, force: true });
});

async function makeWorktreeFixture(base: string, name: string) {
  const parentMemoryDir = join(base, `${name}-parent`);
  const worktreeDir = join(base, `${name}-worktree`);
  const branchName = `letta/reflection/${name}`;
  await mkdir(parentMemoryDir, { recursive: true });
  await execFile("git", ["init", "-q"], { cwd: parentMemoryDir });
  await execFile("git", ["config", "user.email", "test@example.com"], {
    cwd: parentMemoryDir,
  });
  await execFile("git", ["config", "user.name", "Test"], {
    cwd: parentMemoryDir,
  });
  await writeFile(join(parentMemoryDir, "mem.md"), "base\n", "utf-8");
  await execFile("git", ["add", "."], { cwd: parentMemoryDir });
  await execFile("git", ["commit", "-qm", "init"], { cwd: parentMemoryDir });
  const { stdout: baseHeadOut } = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: parentMemoryDir,
  });
  const baseHead = baseHeadOut.trim();
  // Create a real linked worktree on a new branch, then commit a candidate
  // change there. finalizeReflectionMemoryWorktree runs real `git worktree
  // remove`/`branch -D` against parentMemoryDir, so the fixture must be a
  // genuine worktree, not a plain clone.
  await execFile("git", ["worktree", "add", "-b", branchName, worktreeDir], {
    cwd: parentMemoryDir,
  });
  await execFile("git", ["config", "user.email", "test@example.com"], {
    cwd: worktreeDir,
  });
  await execFile("git", ["config", "user.name", "Test"], { cwd: worktreeDir });
  await writeFile(join(worktreeDir, "mem.md"), "base\ncandidate\n", "utf-8");
  await execFile("git", ["add", "."], { cwd: worktreeDir });
  await execFile("git", ["commit", "-qm", "candidate"], { cwd: worktreeDir });
  return {
    id: name,
    parentMemoryDir,
    worktreeBaseDir: base,
    worktreeDir,
    branchName,
    baseHead,
    gitCommonDir: join(parentMemoryDir, ".git"),
  };
}

function buildRun(
  worktrees: ReturnType<typeof makeWorktreeFixture> extends Promise<infer T>
    ? [T, T]
    : never,
  payloadPath: string,
  models: [string, string],
): ReflectionArenaRun {
  return {
    agentId: "agent-parent",
    conversationId: "conv-parent",
    createdAt: new Date().toISOString(),
    endSnapshotLine: 0,
    payloadPath,
    runId: "testrun1",
    status: "awaiting_choice",
    candidates: [
      {
        label: "1",
        model: models[0],
        subagentId: "sub-1",
        worktree: worktrees[0],
        result: { success: true, agentId: "agent-a" },
      },
      {
        label: "2",
        model: models[1],
        subagentId: "sub-2",
        worktree: worktrees[1],
        result: { success: true, agentId: "agent-b" },
      },
    ],
  } as ReflectionArenaRun;
}

async function writeRunFile(run: ReflectionArenaRun): Promise<void> {
  const runsDir = join(arenaRoot, "runs");
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, "testrun1.json"), JSON.stringify(run), "utf-8");
}

async function settle(): Promise<void> {
  // Allow the fire-and-forget vote+flush promise in finalize to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("finalizeReflectionArenaChoice telemetry", () => {
  test("tracks and immediately flushes the arena vote on win", async () => {
    const base = await mkdtemp(join(tmpdir(), "arena-wt-"));
    try {
      const winner = await makeWorktreeFixture(base, "winner");
      const loser = await makeWorktreeFixture(base, "loser");
      const payloadPath = join(base, "payload.json");
      await writeFile(payloadPath, JSON.stringify([{ role: "user" }]), "utf-8");

      const run = buildRun([winner, loser], payloadPath, [
        "letta/auto-memory",
        "lc-anthropic/claude-opus-4-8",
      ]);
      await writeRunFile(run);

      const { message } = await finalizeReflectionArenaChoice({
        choice: "1",
        runId: "testrun1",
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
      });
      await settle();

      expect(trackSpy).toHaveBeenCalledTimes(1);
      const vote = trackSpy.mock.calls[0]?.[0] as TrackedVote;
      expect(vote.run_id).toBe("testrun1");
      expect(vote.choice).toBe("win_loss");
      expect(vote.winner).toBe("letta/auto-memory");
      expect(vote.loser).toBe("lc-anthropic/claude-opus-4-8");
      expect(drainSpy).toHaveBeenCalled();
      expect(message).toContain("Recorded selection");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("flushes a tie vote without merging any candidate", async () => {
    const base = await mkdtemp(join(tmpdir(), "arena-wt-"));
    try {
      const c1 = await makeWorktreeFixture(base, "c1");
      const c2 = await makeWorktreeFixture(base, "c2");
      const payloadPath = join(base, "payload.json");
      await writeFile(payloadPath, JSON.stringify([]), "utf-8");

      const run = buildRun([c1, c2], payloadPath, [
        "letta/auto-memory",
        "gpt-5.5-plus-pro-high",
      ]);
      await writeRunFile(run);

      await finalizeReflectionArenaChoice({
        choice: "tie",
        runId: "testrun1",
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
      });
      await settle();

      expect(trackSpy).toHaveBeenCalledTimes(1);
      const vote = trackSpy.mock.calls[0]?.[0] as TrackedVote;
      expect(vote.choice).toBe("tie");
      expect(drainSpy).toHaveBeenCalled();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("attaches the transcript payload to the vote event", async () => {
    const base = await mkdtemp(join(tmpdir(), "arena-wt-"));
    try {
      const c1 = await makeWorktreeFixture(base, "p1");
      const c2 = await makeWorktreeFixture(base, "p2");
      const payloadPath = join(base, "payload.json");
      const payloadContent = JSON.stringify([
        { role: "user", content: "remember the shortlist" },
      ]);
      await writeFile(payloadPath, payloadContent, "utf-8");

      const run = buildRun([c1, c2], payloadPath, [
        "letta/auto-memory",
        "minimax-m3",
      ]);
      await writeRunFile(run);

      await finalizeReflectionArenaChoice({
        choice: "2",
        runId: "testrun1",
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
      });
      await settle();

      const vote = trackSpy.mock.calls[0]?.[0] as TrackedVote;
      expect(vote.transcript_payload).toBe(payloadContent);
      expect(vote.transcript_payload_chars).toBe(payloadContent.length);
      expect(vote.transcript_payload_truncated).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
