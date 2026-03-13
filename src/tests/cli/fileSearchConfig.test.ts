import { describe, expect, test } from "bun:test";
import {
  shouldExcludeEntry,
  shouldHardExcludeEntry,
} from "../../cli/helpers/fileSearchConfig";

// ---------------------------------------------------------------------------
// shouldExcludeEntry — driven by .lettaignore only (no hardcoded defaults)
// ---------------------------------------------------------------------------

describe("shouldExcludeEntry", () => {
  describe("no hardcoded defaults", () => {
    // Previously hardcoded entries are no longer excluded by default.
    // Users must opt in via .lettaignore.
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
