import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import {
  claimMemoryConflictRepair,
  clearMemoryConflictRepair,
  completeMemoryConflictRepair,
} from "./memory-conflict-repair";

const repos: TempGitRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repository(): string {
  const repo = createTempGitRepo("memory-conflict-repair-");
  repos.push(repo);
  writeFileSync(join(repo.dir, "note.md"), "memory\n");
  repo.git("add", "note.md");
  repo.git("commit", "-q", "-m", "initial");
  return repo.dir;
}

/** Claim, asserting the attempt was recorded, and return its token. */
async function claim(root: string): Promise<string> {
  const result = await claimMemoryConflictRepair(root);
  expect(result.status).toBe("claimed");
  return result.status === "claimed" ? result.token : "";
}

test("a conflict a worker has run on is not attempted again while unchanged", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  await completeMemoryConflictRepair(root, await claim(root));
  expect(await claimMemoryConflictRepair(root)).toEqual({
    status: "attempted",
  });
  // A different incoming commit is a new conflict.
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "b".repeat(40));
  await claim(root);
});

test("a conflict that follows new commits is attempted again", async () => {
  const root = repository();
  await completeMemoryConflictRepair(root, await claim(root));
  writeFileSync(join(root, "note.md"), "updated\n");
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "update"], {
    stdio: "pipe",
  });
  await claim(root);
});

test("a repair still in progress in a running process is not launched twice", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  await claim(root);
  // Still "launching" and this process is alive: in progress.
  expect(await claimMemoryConflictRepair(root)).toEqual({
    status: "in_progress",
  });
});

test("an attempt whose process is gone before the worker ran is retried", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  await claim(root);
  const path = join(root, ".git", "letta-memory-repair.json");
  const attempt = JSON.parse(readFileSync(path, "utf8"));
  // The recording process crashed: its pid was reused.
  writeFileSync(path, JSON.stringify({ ...attempt, started: "1970-01-01" }));
  await claim(root);
});

test("clearing an attempt that never ran lets the same conflict be attempted again", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  await clearMemoryConflictRepair(root, await claim(root));
  await claim(root);
});

test("a stale worker cannot clear or complete a newer attempt", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  const stale = await claim(root);
  await clearMemoryConflictRepair(root, stale);
  const current = await claim(root);
  await clearMemoryConflictRepair(root, stale);
  await completeMemoryConflictRepair(root, stale);
  expect(await claimMemoryConflictRepair(root)).toEqual({
    status: "in_progress",
  });
  await completeMemoryConflictRepair(root, current);
  expect(await claimMemoryConflictRepair(root)).toEqual({
    status: "attempted",
  });
});

test("a checkout that is not a repository is left to the worker", async () => {
  const token = await claim("/nonexistent/memory");
  await clearMemoryConflictRepair("/nonexistent/memory", token);
  await completeMemoryConflictRepair("/nonexistent/memory", token);
});
