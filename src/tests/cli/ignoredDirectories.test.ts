import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureLettaIgnoreFile,
  readLettaIgnorePatterns,
} from "../../cli/helpers/ignoredDirectories";
import { TestDirectory } from "../helpers/testFs";

describe("ensureLettaIgnoreFile", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("creates .lettaignore when missing", () => {
    testDir = new TestDirectory();
    const filePath = join(testDir.path, ".letta", ".lettaignore");

    expect(existsSync(filePath)).toBe(false);
    ensureLettaIgnoreFile(testDir.path);
    expect(existsSync(filePath)).toBe(true);

    // Common patterns are active by default
    const activePatterns = readLettaIgnorePatterns(testDir.path);
    expect(activePatterns).toContain("node_modules");
    expect(activePatterns).toContain("dist");
    expect(activePatterns).toContain(".git");
    expect(activePatterns).toContain("*.log");
    expect(activePatterns).toContain("package-lock.json");
  });

  test("does not overwrite existing .lettaignore", () => {
    testDir = new TestDirectory();
    const lettaDir = join(testDir.path, ".letta");
    const filePath = join(lettaDir, ".lettaignore");

    mkdirSync(lettaDir, { recursive: true });
    writeFileSync(filePath, "custom-pattern\n", "utf-8");
    ensureLettaIgnoreFile(testDir.path);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("custom-pattern\n");
  });
});

describe("readLettaIgnorePatterns", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("returns empty array when file is missing", () => {
    testDir = new TestDirectory();
    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual([]);
  });

  test("parses patterns from file", () => {
    testDir = new TestDirectory();
    const lettaDir = join(testDir.path, ".letta");
    mkdirSync(lettaDir, { recursive: true });
    writeFileSync(
      join(lettaDir, ".lettaignore"),
      "*.log\nvendor\nsrc/generated/**\n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["*.log", "vendor", "src/generated/**"]);
  });

  test("skips comments and blank lines", () => {
    testDir = new TestDirectory();
    const lettaDir = join(testDir.path, ".letta");
    mkdirSync(lettaDir, { recursive: true });
    writeFileSync(
      join(lettaDir, ".lettaignore"),
      "# This is a comment\n\n  \npattern1\n# Another comment\npattern2\n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["pattern1", "pattern2"]);
  });

  test("skips negation patterns", () => {
    testDir = new TestDirectory();
    const lettaDir = join(testDir.path, ".letta");
    mkdirSync(lettaDir, { recursive: true });
    writeFileSync(
      join(lettaDir, ".lettaignore"),
      "*.log\n!important.log\nvendor\n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["*.log", "vendor"]);
  });

  test("trims whitespace from patterns", () => {
    testDir = new TestDirectory();
    const lettaDir = join(testDir.path, ".letta");
    mkdirSync(lettaDir, { recursive: true });
    writeFileSync(
      join(lettaDir, ".lettaignore"),
      "  *.log  \n  vendor  \n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["*.log", "vendor"]);
  });
});
