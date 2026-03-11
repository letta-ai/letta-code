import { describe, expect, test } from "bun:test";
import {
  shouldExcludeEntry,
  shouldHardExcludeEntry,
} from "../../cli/helpers/fileSearchConfig";

// ---------------------------------------------------------------------------
// shouldExcludeEntry — hardcoded defaults
// ---------------------------------------------------------------------------

describe("shouldExcludeEntry", () => {
  describe("hardcoded defaults", () => {
    const hardcoded = [
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

    for (const name of hardcoded) {
      test(`excludes "${name}"`, () => {
        expect(shouldExcludeEntry(name)).toBe(true);
      });
    }

    test("exclusion is case-insensitive", () => {
      expect(shouldExcludeEntry("Node_Modules")).toBe(true);
      expect(shouldExcludeEntry("DIST")).toBe(true);
      expect(shouldExcludeEntry("BUILD")).toBe(true);
      expect(shouldExcludeEntry(".GIT")).toBe(true);
    });
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
// shouldHardExcludeEntry — hardcoded only, no .lettaignore
// ---------------------------------------------------------------------------

describe("shouldHardExcludeEntry", () => {
  test("excludes hardcoded defaults", () => {
    expect(shouldHardExcludeEntry("node_modules")).toBe(true);
    expect(shouldHardExcludeEntry(".git")).toBe(true);
    expect(shouldHardExcludeEntry("dist")).toBe(true);
  });

  test("exclusion is case-insensitive", () => {
    expect(shouldHardExcludeEntry("Node_Modules")).toBe(true);
    expect(shouldHardExcludeEntry("DIST")).toBe(true);
  });

  test("does not exclude normal entries", () => {
    expect(shouldHardExcludeEntry("src")).toBe(false);
    expect(shouldHardExcludeEntry("index.ts")).toBe(false);
  });
});
