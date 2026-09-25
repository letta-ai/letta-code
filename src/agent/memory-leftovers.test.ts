import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installPreCommitHook } from "@/agent/memory-git-hooks";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import { commitLeftoverMemoryChanges } from "./memory-leftovers";

const repos: TempGitRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

/** A local memory checkout with the MemFS pre-commit hook and one commit. */
function checkout(): TempGitRepo {
  const repo = createTempGitRepo("memory-leftovers-");
  repos.push(repo);
  mkdirSync(join(repo.dir, "system"));
  writeFileSync(
    join(repo.dir, "system", "user.md"),
    "---\ndescription: The user\n---\n\nOriginal.\n",
  );
  repo.git("add", "system/user.md");
  repo.git("commit", "-q", "-m", "initial");
  installPreCommitHook(repo.dir, true);
  return repo;
}

test("commits everything a turn left behind, authored as the agent", async () => {
  const repo = checkout();
  writeFileSync(
    join(repo.dir, "system", "user.md"),
    "---\ndescription: The user\n---\n\nEdited.\n",
  );
  writeFileSync(
    join(repo.dir, "system", "notes.md"),
    "---\ndescription: New notes\n---\n\nNew.\n",
  );
  const result = await commitLeftoverMemoryChanges({
    memoryDir: repo.dir,
    agentId: "agent-42",
    authorName: "Ada",
    localOnly: true,
  });
  expect(result.committed).toBe(true);
  expect(repo.git("status", "--porcelain")).toBe("");
  expect(repo.git("log", "-1", "--format=%an <%ae>")).toBe(
    "Ada <agent-42@letta.com>",
  );
  expect(repo.git("log", "-1", "--format=%s")).toContain("left after the turn");
  expect(repo.git("show", "--stat", "--format=", "HEAD")).toContain("notes.md");
});

test("falls back to the agent id as author name", async () => {
  const repo = checkout();
  writeFileSync(
    join(repo.dir, "system", "user.md"),
    "---\ndescription: x\n---\n",
  );
  await commitLeftoverMemoryChanges({
    memoryDir: repo.dir,
    agentId: "agent-42",
    localOnly: true,
  });
  expect(repo.git("log", "-1", "--format=%an")).toBe("agent-42");
});

test("leaves what the pre-commit hook rejects uncommitted and reports why", async () => {
  const repo = checkout();
  writeFileSync(join(repo.dir, "system", "broken.md"), "no frontmatter\n");
  const result = await commitLeftoverMemoryChanges({
    memoryDir: repo.dir,
    agentId: "agent-42",
    localOnly: true,
  });
  expect(result.committed).toBe(false);
  if (!result.committed) expect(result.error).toContain("broken.md");
  expect(repo.git("log", "--format=%s")).toBe("initial");
  // Nothing stays staged for the agent to trip over.
  expect(repo.git("diff", "--cached", "--name-only")).toBe("");
  expect(repo.git("status", "--porcelain")).toContain("broken.md");
});
