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

test("a conflict a worker has run on is not attempted again while unchanged", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  await completeMemoryConflictRepair(root);
  expect(await claimMemoryConflictRepair(root)).toBe(false);
  // A different incoming commit is a new conflict.
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "b".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
});

test("a conflict that follows new commits is attempted again", async () => {
  const root = repository();
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  await completeMemoryConflictRepair(root);
  writeFileSync(join(root, "note.md"), "updated\n");
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "update"], {
    stdio: "pipe",
  });
  expect(await claimMemoryConflictRepair(root)).toBe(true);
});

test("a repair still in progress in a running process is not launched twice", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  // Still "launching" and this process is alive: in progress.
  expect(await claimMemoryConflictRepair(root)).toBe(false);
});

test("an attempt whose process is gone before the worker ran is retried", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  const path = join(root, ".git", "letta-memory-repair.json");
  const attempt = JSON.parse(readFileSync(path, "utf8"));
  // The recording process crashed or was cancelled: its pid was reused.
  writeFileSync(path, JSON.stringify({ ...attempt, started: "1970-01-01" }));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
});

test("clearing an attempt that never ran lets the same conflict be attempted again", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  await clearMemoryConflictRepair(root);
  expect(await claimMemoryConflictRepair(root)).toBe(true);
});

test("a checkout that is not a repository is left to the worker", async () => {
  expect(await claimMemoryConflictRepair("/nonexistent/memory")).toBe(true);
  await clearMemoryConflictRepair("/nonexistent/memory");
  await completeMemoryConflictRepair("/nonexistent/memory");
});
