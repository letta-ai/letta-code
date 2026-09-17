import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { __testSetBackend } from "@/backend";
import { propose_memory_patch } from "@/tools/impl/propose-memory-patch";

const execFile = promisify(execFileCb);

let tempRoot: string;
let memoryDir: string;
const originalMemoryDir = process.env.MEMORY_DIR;
const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;

async function initRepo(directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true });
  await execFile("git", ["init", "-b", "main"], { cwd: directory });
  await execFile("git", ["config", "user.email", "test@test.com"], {
    cwd: directory,
  });
  await execFile("git", ["config", "user.name", "test"], { cwd: directory });
  await execFile("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: directory,
  });
}

beforeEach(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "propose-memory-patch-"));
  memoryDir = join(tempRoot, "memory");
  await initRepo(memoryDir);
  process.env.MEMORY_DIR = memoryDir;
  process.env.LETTA_MEMORY_DIR = memoryDir;
  __testSetBackend({
    capabilities: { localMemfs: false },
  } as never);
});

afterEach(async () => {
  __testSetBackend(null);
  if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = originalMemoryDir;
  if (originalLettaMemoryDir === undefined) delete process.env.LETTA_MEMORY_DIR;
  else process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("propose_memory_patch", () => {
  test("drafts files without committing", async () => {
    const result = await propose_memory_patch({
      reason: "Add contacts",
      input: [
        "*** Begin Patch",
        "*** Add File: system/contacts.md",
        "+---",
        "+description: Contacts",
        "+---",
        "+Sarah: cofounder",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result.message).toContain("system/contacts.md");
    expect(result.message).toContain("harness will validate and commit");
    expect(
      readFileSync(join(memoryDir, "system/contacts.md"), "utf8"),
    ).toContain("Sarah: cofounder");

    const status = await execFile("git", ["status", "--porcelain"], {
      cwd: memoryDir,
    });
    expect(status.stdout.trim().length).toBeGreaterThan(0);

    const log = await execFile("git", ["log", "--oneline"], {
      cwd: memoryDir,
    });
    expect(log.stdout).not.toContain("Add contacts");
  });

  test("refuses to resolve a child agent id when MEMORY_DIR is unset", async () => {
    delete process.env.MEMORY_DIR;
    delete process.env.LETTA_MEMORY_DIR;
    await expect(
      propose_memory_patch({
        reason: "nope",
        input: "*** Begin Patch\n*** End Patch\n",
      }),
    ).rejects.toThrow(/MEMORY_DIR is not set/);
  });
});
