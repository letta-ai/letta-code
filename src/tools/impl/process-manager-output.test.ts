import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  __resetBackgroundOutputDirForTests,
  createBackgroundOutputFile,
  getBackgroundOutputDir,
} from "@/tools/impl/process_manager";

const originalScratchpad = process.env.LETTA_SCRATCHPAD;
const originalTmpdir = process.env.TMPDIR;
const originalTmp = process.env.TMP;
const originalTemp = process.env.TEMP;
const isWindows = process.platform === "win32";
let tempRoots: string[] = [];

function restoreBackgroundOutputEnv(): void {
  if (originalScratchpad === undefined) {
    delete process.env.LETTA_SCRATCHPAD;
  } else {
    process.env.LETTA_SCRATCHPAD = originalScratchpad;
  }

  if (originalTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpdir;
  }

  if (originalTmp === undefined) {
    delete process.env.TMP;
  } else {
    process.env.TMP = originalTmp;
  }

  if (originalTemp === undefined) {
    delete process.env.TEMP;
  } else {
    process.env.TEMP = originalTemp;
  }
}

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function useTempRootForTmpdir(): string {
  const root = makeTempRoot("letta-bg-tmp-");
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return root;
}

function expectPosixMode(path: string, mode: number): void {
  if (isWindows) {
    return;
  }

  expect(statSync(path).mode & 0o777).toBe(mode);
}

describe("background output files", () => {
  afterEach(() => {
    __resetBackgroundOutputDirForTests();
    restoreBackgroundOutputEnv();

    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  test("uses LETTA_SCRATCHPAD when explicitly configured", () => {
    const scratchpad = makeTempRoot("letta-bg-scratch-");
    process.env.LETTA_SCRATCHPAD = scratchpad;

    const outputFile = createBackgroundOutputFile("task_scratchpad");

    expect(getBackgroundOutputDir()).toBe(scratchpad);
    expect(dirname(outputFile)).toBe(scratchpad);
    expect(basename(outputFile)).toBe("task_scratchpad.log");
    expect(existsSync(outputFile)).toBe(true);
    expectPosixMode(outputFile, 0o600);
  });

  test("creates one private temp directory for the current process", () => {
    const tempRoot = useTempRootForTmpdir();
    delete process.env.LETTA_SCRATCHPAD;

    const outputDir = getBackgroundOutputDir();
    const outputFile = createBackgroundOutputFile("exec_1");

    expect(outputDir.startsWith(join(tempRoot, "letta-background-"))).toBe(
      true,
    );
    expect(getBackgroundOutputDir()).toBe(outputDir);
    expect(dirname(outputFile)).toBe(outputDir);
    expect(basename(outputFile)).toBe("exec_1.log");
    expect(existsSync(outputFile)).toBe(true);
    expectPosixMode(outputDir, 0o700);
    expectPosixMode(outputFile, 0o600);
  });

  test("separates reused filenames across independent temp directories", () => {
    const tempRoot = useTempRootForTmpdir();
    delete process.env.LETTA_SCRATCHPAD;

    const firstOutputFile = createBackgroundOutputFile("exec_1");
    const firstOutputDir = dirname(firstOutputFile);

    __resetBackgroundOutputDirForTests();

    const secondOutputFile = createBackgroundOutputFile("exec_1");
    const secondOutputDir = dirname(secondOutputFile);

    expect(firstOutputDir.startsWith(join(tempRoot, "letta-background-"))).toBe(
      true,
    );
    expect(
      secondOutputDir.startsWith(join(tempRoot, "letta-background-")),
    ).toBe(true);
    expect(firstOutputDir).not.toBe(secondOutputDir);
    expect(basename(firstOutputFile)).toBe("exec_1.log");
    expect(basename(secondOutputFile)).toBe("exec_1.log");
    expect(existsSync(firstOutputFile)).toBe(true);
    expect(existsSync(secondOutputFile)).toBe(true);
  });
});
