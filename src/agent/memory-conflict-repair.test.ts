import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimMemoryOperation } from "@/agent/memory-operation";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import { claimMemoryConflictRepair } from "./memory-conflict-repair";

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

test("the same unfinished operation is handed to a repair worker only once", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  expect(await claimMemoryConflictRepair(root)).not.toBeNull();
  expect(await claimMemoryConflictRepair(root)).toBeNull();
  // A different incoming commit is a new conflict.
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "b".repeat(40));
  expect(await claimMemoryConflictRepair(root)).not.toBeNull();
});

test("a conflict that follows new commits is attempted again", async () => {
  const root = repository();
  expect(await claimMemoryConflictRepair(root)).not.toBeNull();
  writeFileSync(join(root, "note.md"), "updated\n");
  execFileSync("git", ["-C", root, "commit", "-q", "-am", "update"], {
    stdio: "pipe",
  });
  expect(await claimMemoryConflictRepair(root)).not.toBeNull();
});

test("a checkout that is not a repository is left to the worker", async () => {
  const release = await claimMemoryConflictRepair("/nonexistent/memory");
  expect(release).not.toBeNull();
  await release?.();
});

test("releasing a cancelled attempt lets the same conflict be attempted again", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  const release = await claimMemoryConflictRepair(root);
  expect(release).not.toBeNull();
  await release?.();
  expect(await claimMemoryConflictRepair(root)).not.toBeNull();
});

test("a stale release does not forget a newer attempt", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  const first = await claimMemoryConflictRepair(root);
  // Forget the first attempt, then record a second one for the same conflict.
  await first?.();
  const second = await claimMemoryConflictRepair(root);
  expect(second).not.toBeNull();
  // The first handle is stale now; releasing it must not clear the second.
  await first?.();
  expect(await claimMemoryConflictRepair(root)).toBeNull();
  await second?.();
});

test("a cancelled attempt is left in place while another process holds the checkout", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
  const release = await claimMemoryConflictRepair(root);
  expect(release).not.toBeNull();
  const lease = await claimMemoryOperation(root);
  await release?.();
  // Still recorded: the release could not take the lease safely.
  expect(await claimMemoryConflictRepair(root)).toBeNull();
  await lease?.();
  await release?.();
  expect(await claimMemoryConflictRepair(root)).not.toBeNull();
});
