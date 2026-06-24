import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getGlobalModsDirectory,
  getLegacyGlobalExtensionsDirectory,
  resolveDefaultGlobalModsDirectory,
} from "@/mods/paths";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-paths-"));
}

describe("mod paths", () => {
  test("defaults new users to the mods directory", () => {
    const root = createTempDir();
    try {
      expect(resolveDefaultGlobalModsDirectory(root)).toBe(
        getGlobalModsDirectory(root),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("uses legacy extensions directory when it is the only existing directory", () => {
    const root = createTempDir();
    try {
      const legacyDirectory = getLegacyGlobalExtensionsDirectory(root);
      mkdirSync(legacyDirectory, { recursive: true });

      expect(resolveDefaultGlobalModsDirectory(root)).toBe(legacyDirectory);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("prefers mods directory when both new and legacy directories exist", () => {
    const root = createTempDir();
    try {
      const modsDirectory = getGlobalModsDirectory(root);
      mkdirSync(modsDirectory, { recursive: true });
      mkdirSync(getLegacyGlobalExtensionsDirectory(root), { recursive: true });

      expect(resolveDefaultGlobalModsDirectory(root)).toBe(modsDirectory);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
