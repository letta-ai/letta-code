import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimMemoryConflictRepair,
  releaseMemoryConflictRepair,
} from "./memory-conflict-repair";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-conflict-repair-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "note.md"), "memory\n");
  git("add", "note.md");
  git("commit", "-q", "-m", "initial");
  return root;
}

test("the same unfinished operation is handed to a repair worker only once", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  expect(await claimMemoryConflictRepair(root)).toBe(false);
  // A different incoming commit is a new conflict.
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "b".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
});

test("a conflict that follows new commits is attempted again", async () => {
  const root = repository();
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  writeFileSync(join(root, "note.md"), "updated\n");
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "update"], {
    stdio: "pipe",
  });
  expect(await claimMemoryConflictRepair(root)).toBe(true);
});

test("a checkout that is not a repository is left to the worker", async () => {
  expect(await claimMemoryConflictRepair("/nonexistent/memory")).toBe(true);
});

test("a cancelled attempt does not count against the same conflict", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  await releaseMemoryConflictRepair(root);
  expect(await claimMemoryConflictRepair(root)).toBe(true);
  await releaseMemoryConflictRepair("/nonexistent/memory");
});
