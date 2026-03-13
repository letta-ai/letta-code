import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldExcludeEntry,
  shouldHardExcludeEntry,
} from "../../cli/helpers/fileSearchConfig";

// These tests rely on there being NO .letta/.lettaignore in the working
// directory — they verify that nothing is excluded unless the user explicitly
// opts in via .letta/.lettaignore.  Each test therefore runs from a fresh
// temporary directory that contains no ignore file.

let testDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = join(
    tmpdir(),
    `letta-fsc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// shouldExcludeEntry — driven by .lettaignore only (no hardcoded defaults)
// ---------------------------------------------------------------------------

describe("shouldExcludeEntry", () => {
  describe("no hardcoded defaults", () => {
    // Without a .lettaignore, none of these entries are excluded.
    const formerlyHardcoded = [
      "node_modules",
      "bower_components",
      "dist",
      "build",
      "out",
      "coverage",
      ".next",
      ".nuxt",
      "venv",
      ".venv",
      "__pycache__",
      ".tox",
      "target",
      ".git",
      ".cache",
    ];

    for (const name of formerlyHardcoded) {
      test(`does not exclude "${name}" without a .lettaignore entry`, () => {
        expect(shouldExcludeEntry(name)).toBe(false);
      });
    }
  });

  describe("non-excluded entries", () => {
    test("does not exclude normal directories", () => {
      expect(shouldExcludeEntry("src")).toBe(false);
      expect(shouldExcludeEntry("lib")).toBe(false);
      expect(shouldExcludeEntry("tests")).toBe(false);
      expect(shouldExcludeEntry("components")).toBe(false);
    });

    test("does not exclude normal files", () => {
      expect(shouldExcludeEntry("index.ts")).toBe(false);
      expect(shouldExcludeEntry("README.md")).toBe(false);
      expect(shouldExcludeEntry("package.json")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// shouldHardExcludeEntry — driven by .lettaignore name patterns only
// ---------------------------------------------------------------------------

describe("shouldHardExcludeEntry", () => {
  test("does not exclude previously hardcoded entries without a .lettaignore entry", () => {
    expect(shouldHardExcludeEntry("node_modules")).toBe(false);
    expect(shouldHardExcludeEntry(".git")).toBe(false);
    expect(shouldHardExcludeEntry("dist")).toBe(false);
  });

  test("does not exclude normal entries", () => {
    expect(shouldHardExcludeEntry("src")).toBe(false);
    expect(shouldHardExcludeEntry("index.ts")).toBe(false);
  });
});
