import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    const filePath = join(testDir.path, ".lettaignore");

    expect(existsSync(filePath)).toBe(false);
    ensureLettaIgnoreFile(testDir.path);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("package-lock.json");
    expect(content).toContain("*.log");
    expect(content).toContain(".DS_Store");
  });

  test("does not overwrite existing .lettaignore", () => {
    testDir = new TestDirectory();
    const filePath = join(testDir.path, ".lettaignore");

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
    writeFileSync(
      join(testDir.path, ".lettaignore"),
      "*.log\nvendor\nsrc/generated/**\n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["*.log", "vendor", "src/generated/**"]);
  });

  test("skips comments and blank lines", () => {
    testDir = new TestDirectory();
    writeFileSync(
      join(testDir.path, ".lettaignore"),
      "# This is a comment\n\n  \npattern1\n# Another comment\npattern2\n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["pattern1", "pattern2"]);
  });

  test("skips negation patterns", () => {
    testDir = new TestDirectory();
    writeFileSync(
      join(testDir.path, ".lettaignore"),
      "*.log\n!important.log\nvendor\n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["*.log", "vendor"]);
  });

  test("trims whitespace from patterns", () => {
    testDir = new TestDirectory();
    writeFileSync(
      join(testDir.path, ".lettaignore"),
      "  *.log  \n  vendor  \n",
      "utf-8",
    );

    const patterns = readLettaIgnorePatterns(testDir.path);
    expect(patterns).toEqual(["*.log", "vendor"]);
  });
});
