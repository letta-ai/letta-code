import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMemoryAtBudgetStop } from "@/headless-run-limits";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

test("a budget stop commits memory left uncommitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-stop-memory-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "notes.md"), "a lesson\n");
  commitMemoryAtBudgetStop(dir);
  expect(git(dir, "status", "--porcelain")).toBe("");
  expect(git(dir, "log", "-1", "--format=%s")).toContain("budget stop");
});
