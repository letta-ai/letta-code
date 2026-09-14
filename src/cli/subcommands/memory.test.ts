import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runMemorySubcommand } from "@/cli/subcommands/memory";

const AGENT_ID = "agent-restore-test";

describe("letta memory restore", () => {
  let storageDir: string;
  let memoryDir: string;
  let priorLocalBackend: string | undefined;
  let priorStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "memory-restore-"));
    memoryDir = join(storageDir, "memfs", AGENT_ID, "memory");
    priorLocalBackend = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    priorStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "current memory");
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
    if (priorLocalBackend === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    } else {
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = priorLocalBackend;
    }
    if (priorStorageDir === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_DIR;
    } else {
      process.env.LETTA_LOCAL_BACKEND_DIR = priorStorageDir;
    }
  });

  test("rejects a restore source inside active memory without deleting either", async () => {
    const sourceDir = join(memoryDir, "nested-backup");
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, "MEMORY.md"), "backup memory");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const code = await runMemorySubcommand([
        "restore",
        "--agent",
        AGENT_ID,
        "--from",
        sourceDir,
        "--force",
      ]);

      expect(code).toBe(1);
      expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe(
        "current memory",
      );
      expect(existsSync(join(sourceDir, "MEMORY.md"))).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("overlaps active memory"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("stages a valid backup before replacing active memory", async () => {
    const agentRoot = dirname(memoryDir);
    const sourceDir = join(agentRoot, "memory-backup-test");
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, "MEMORY.md"), "backup memory");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      const code = await runMemorySubcommand([
        "restore",
        "--agent",
        AGENT_ID,
        "--from",
        sourceDir,
        "--force",
      ]);

      expect(code).toBe(0);
      expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe(
        "backup memory",
      );
      expect(readFileSync(join(sourceDir, "MEMORY.md"), "utf8")).toBe(
        "backup memory",
      );
      expect(
        readdirSync(agentRoot).some((name) =>
          name.startsWith(".memory-restore-"),
        ),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });
});
