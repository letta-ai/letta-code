import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLocalStorage } from "./headless-scenario";

let root: string;
let memoryDir: string;

function git(...args: string[]) {
  execFileSync("git", ["-C", memoryDir, ...args], { stdio: "pipe" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "headless-scenario-storage-"));
  mkdirSync(join(root, "agents"));
  // The worker sorts before its parent and deliberately has no own checkout.
  writeFileSync(
    join(root, "agents", "a-worker.json"),
    JSON.stringify({
      id: "a-worker",
      tags: ["type:memory", "parent:z-primary"],
    }),
  );
  writeFileSync(
    join(root, "agents", "z-primary.json"),
    JSON.stringify({ id: "z-primary", tags: [] }),
  );
  memoryDir = join(root, "memfs", "z-primary", "memory");
  mkdirSync(join(memoryDir, "reference", "ci"), { recursive: true });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "Initialize memory");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeMemory(marker = "LOCAL_MEMFS_SCENARIO_OK") {
  writeFileSync(
    join(memoryDir, "reference", "ci", "local-backend.md"),
    `---\ndescription: Local backend CI scenario\n---\n${marker}\n`,
  );
}

test("validates committed parent memory when a fresh worker sorts first", async () => {
  writeMemory();
  git("add", ".");
  git("commit", "-m", "Save delegated memory");
  await expect(validateLocalStorage(root)).resolves.toBeUndefined();
});

test("a saved but uncommitted update does not pass the scenario", async () => {
  writeMemory();
  await expect(validateLocalStorage(root)).rejects.toThrow(
    "commit the delegated memory update",
  );
});

test("a successful commit still needs the requested memory content", async () => {
  writeMemory("unrelated content");
  git("add", ".");
  git("commit", "-m", "Save unrelated memory");
  await expect(validateLocalStorage(root)).rejects.toThrow(
    "missing expected marker",
  );
});

test("direct primary edits do not pass as background memory delegation", async () => {
  rmSync(join(root, "agents", "a-worker.json"));
  writeMemory();
  git("add", ".");
  git("commit", "-m", "Save memory directly");
  await expect(validateLocalStorage(root)).rejects.toThrow(
    "did not launch a memory worker",
  );
});
