import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getGlobalModsDirectory,
  getLegacyGlobalExtensionsDirectory,
  LEGACY_LETTA_EXTENSIONS_DIR_ENV,
  LETTA_MODS_DIR_ENV,
  resolveDefaultGlobalModsDirectory,
  resolveGlobalModDirectories,
} from "@/mods/paths";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-paths-"));
}

describe("mod paths", () => {
  test("uses LETTA_MODS_DIR when present", () => {
    const root = createTempDir();
    try {
      const envDirectory = path.join(root, "candidate-mods");

      expect(
        resolveDefaultGlobalModsDirectory(root, {
          [LETTA_MODS_DIR_ENV]: envDirectory,
        }),
      ).toBe(envDirectory);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("uses legacy LETTA_EXTENSIONS_DIR when mods env is absent", () => {
    const root = createTempDir();
    try {
      const envDirectory = path.join(root, "candidate-extensions");

      expect(
        resolveDefaultGlobalModsDirectory(root, {
          [LEGACY_LETTA_EXTENSIONS_DIR_ENV]: envDirectory,
        }),
      ).toBe(envDirectory);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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

  test("resolveGlobalModDirectories defaults to ~/.letta/mods/ and ~/.letta/extensions/", () => {
    const root = createTempDir();
    try {
      const result = resolveGlobalModDirectories(root, {});
      expect(result.globalModsDirectory).toBe(getGlobalModsDirectory(root));
      expect(result.legacyGlobalExtensionsDirectory).toBe(
        getLegacyGlobalExtensionsDirectory(root),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("resolveGlobalModDirectories respects LETTA_MODS_DIR for global directory", () => {
    const root = createTempDir();
    try {
      const envDirectory = path.join(root, "custom-mods");
      const result = resolveGlobalModDirectories(root, {
        [LETTA_MODS_DIR_ENV]: envDirectory,
      });
      expect(result.globalModsDirectory).toBe(envDirectory);
      // Legacy directory is still the hardcoded default
      expect(result.legacyGlobalExtensionsDirectory).toBe(
        getLegacyGlobalExtensionsDirectory(root),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("resolveGlobalModDirectories respects LETTA_EXTENSIONS_DIR for legacy directory", () => {
    const root = createTempDir();
    try {
      const envDirectory = path.join(root, "custom-extensions");
      const result = resolveGlobalModDirectories(root, {
        [LEGACY_LETTA_EXTENSIONS_DIR_ENV]: envDirectory,
      });
      expect(result.globalModsDirectory).toBe(getGlobalModsDirectory(root));
      expect(result.legacyGlobalExtensionsDirectory).toBe(envDirectory);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("resolveGlobalModDirectories resolves both env vars independently", () => {
    const root = createTempDir();
    try {
      const modsDir = path.join(root, "my-mods");
      const extDir = path.join(root, "my-extensions");
      const result = resolveGlobalModDirectories(root, {
        [LETTA_MODS_DIR_ENV]: modsDir,
        [LEGACY_LETTA_EXTENSIONS_DIR_ENV]: extDir,
      });
      expect(result.globalModsDirectory).toBe(modsDir);
      expect(result.legacyGlobalExtensionsDirectory).toBe(extDir);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
