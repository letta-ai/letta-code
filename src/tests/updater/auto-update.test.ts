import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildInstallCommand,
  buildLatestVersionUrl,
  checkForUpdate,
  detectPackageManager,
  resolveUpdateInstallRegistryUrl,
  resolveUpdatePackageName,
  resolveUpdateRegistryBaseUrl,
} from "../../updater/auto-update";

describe("auto-update ENOTEMPTY handling", () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temp directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "letta-test-"));
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("cleanupOrphanedDirs logic", () => {
    test("removes directories starting with .letta-code-", async () => {
      // Create test directories
      const lettaAiDir = path.join(testDir, "lib/node_modules/@letta-ai");
      fs.mkdirSync(lettaAiDir, { recursive: true });

      // Create orphaned temp dirs (should be removed)
      const orphan1 = path.join(lettaAiDir, ".letta-code-abc123");
      const orphan2 = path.join(lettaAiDir, ".letta-code-xyz789");
      fs.mkdirSync(orphan1);
      fs.mkdirSync(orphan2);

      // Create legitimate dirs (should NOT be removed)
      const legitimate = path.join(lettaAiDir, "letta-code");
      const otherPackage = path.join(lettaAiDir, "other-package");
      fs.mkdirSync(legitimate);
      fs.mkdirSync(otherPackage);

      // Simulate cleanup logic
      const { readdir, rm } = await import("node:fs/promises");
      const entries = await readdir(lettaAiDir);
      for (const entry of entries) {
        if (entry.startsWith(".letta-code-")) {
          await rm(path.join(lettaAiDir, entry), {
            recursive: true,
            force: true,
          });
        }
      }

      // Verify
      expect(fs.existsSync(orphan1)).toBe(false);
      expect(fs.existsSync(orphan2)).toBe(false);
      expect(fs.existsSync(legitimate)).toBe(true);
      expect(fs.existsSync(otherPackage)).toBe(true);
    });

    test("handles non-existent directory gracefully", async () => {
      const nonExistent = path.join(testDir, "does/not/exist");
      const { readdir } = await import("node:fs/promises");

      // This should not throw
      let error: NodeJS.ErrnoException | null = null;
      try {
        await readdir(nonExistent);
      } catch (e) {
        error = e as NodeJS.ErrnoException;
      }

      expect(error).not.toBeNull();
      expect(error?.code).toBe("ENOENT");
    });

    test("handles empty directory", async () => {
      const emptyDir = path.join(testDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });

      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(emptyDir);

      expect(entries).toEqual([]);
    });
  });

  describe("ENOTEMPTY error detection", () => {
    test("detects ENOTEMPTY in npm error message", () => {
      const npmError = `npm error code ENOTEMPTY
npm error syscall rename
npm error path /Users/user/.npm-global/lib/node_modules/@letta-ai/letta-code
npm error dest /Users/user/.npm-global/lib/node_modules/@letta-ai/.letta-code-lnWEqMep
npm error errno -66
npm error ENOTEMPTY: directory not empty`;

      expect(npmError.includes("ENOTEMPTY")).toBe(true);
    });

    test("detects ENOTEMPTY in error.message", () => {
      const error = new Error(
        "Command failed: npm install -g @letta-ai/letta-code@latest\nnpm error ENOTEMPTY: directory not empty",
      );

      expect(error.message.includes("ENOTEMPTY")).toBe(true);
    });

    test("does not false-positive on other errors", () => {
      const networkError = "npm error ETIMEDOUT: network timeout";
      const permissionError = "npm error EACCES: permission denied";

      expect(networkError.includes("ENOTEMPTY")).toBe(false);
      expect(permissionError.includes("ENOTEMPTY")).toBe(false);
    });
  });

  describe("npm global path detection", () => {
    test("path structure for cleanup is correct", () => {
      // Test that the path we construct is valid
      const globalPrefix = "/Users/test/.npm-global";
      const lettaAiDir = path.join(globalPrefix, "lib/node_modules/@letta-ai");

      // path.join normalizes separators for the current platform
      expect(lettaAiDir).toContain("lib");
      expect(lettaAiDir).toContain("node_modules");
      expect(lettaAiDir).toContain("@letta-ai");
    });

    test("path structure works on Windows-style paths", () => {
      // Windows uses different separators but path.join handles it
      const globalPrefix = "C:\\Users\\test\\AppData\\Roaming\\npm";
      const lettaAiDir = path.join(globalPrefix, "lib/node_modules/@letta-ai");

      // path.join normalizes separators for the current platform
      expect(lettaAiDir).toContain("lib");
      expect(lettaAiDir).toContain("node_modules");
      expect(lettaAiDir).toContain("@letta-ai");
    });
  });
});

describe("detectPackageManager", () => {
  let originalArgv1: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalArgv1 = process.argv[1] || "";
    originalEnv = process.env.LETTA_PACKAGE_MANAGER;
    delete process.env.LETTA_PACKAGE_MANAGER;
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    if (originalEnv !== undefined) {
      process.env.LETTA_PACKAGE_MANAGER = originalEnv;
    } else {
      delete process.env.LETTA_PACKAGE_MANAGER;
    }
  });

  test("detects bun from path containing /.bun/", () => {
    process.argv[1] =
      "/Users/test/.bun/install/global/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("detects pnpm from path containing /.pnpm/", () => {
    process.argv[1] =
      "/Users/test/.local/share/pnpm/global/5/.pnpm/@letta-ai+letta-code@0.14.11/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("pnpm");
  });

  test("detects pnpm from path containing /pnpm/", () => {
    process.argv[1] =
      "/Users/test/.local/share/pnpm/global/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("pnpm");
  });

  test("defaults to npm for standard nvm path", () => {
    process.argv[1] =
      "/Users/test/.nvm/versions/node/v20.10.0/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("npm");
  });

  test("defaults to npm for standard npm global path", () => {
    process.argv[1] =
      "/usr/local/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("npm");
  });

  test("detects bun from Windows-style path", () => {
    process.argv[1] =
      "C:\\Users\\test\\.bun\\install\\global\\node_modules\\@letta-ai\\letta-code\\dist\\index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("LETTA_PACKAGE_MANAGER override returns specified PM", () => {
    process.env.LETTA_PACKAGE_MANAGER = "bun";
    // Even with an npm-style path, env var wins
    process.argv[1] =
      "/usr/local/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("invalid LETTA_PACKAGE_MANAGER falls back to path detection", () => {
    process.env.LETTA_PACKAGE_MANAGER = "invalid";
    process.argv[1] =
      "/Users/test/.bun/install/global/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("invalid LETTA_PACKAGE_MANAGER with npm path falls back to npm", () => {
    process.env.LETTA_PACKAGE_MANAGER = "yarn";
    process.argv[1] =
      "/usr/local/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("npm");
  });
});

describe("update config resolution", () => {
  test("resolveUpdatePackageName uses default when unset", () => {
    expect(resolveUpdatePackageName({} as NodeJS.ProcessEnv)).toBe(
      "@letta-ai/letta-code",
    );
  });

  test("resolveUpdatePackageName uses valid override", () => {
    expect(
      resolveUpdatePackageName({
        LETTA_UPDATE_PACKAGE_NAME: "@scope/pkg",
      } as NodeJS.ProcessEnv),
    ).toBe("@scope/pkg");
  });

  test("resolveUpdatePackageName ignores invalid override", () => {
    expect(
      resolveUpdatePackageName({
        LETTA_UPDATE_PACKAGE_NAME: "bad pkg",
      } as NodeJS.ProcessEnv),
    ).toBe("@letta-ai/letta-code");
  });

  test("resolveUpdatePackageName ignores command-substitution-like override", () => {
    expect(
      resolveUpdatePackageName({
        LETTA_UPDATE_PACKAGE_NAME: "@scope/pkg$(id)",
      } as NodeJS.ProcessEnv),
    ).toBe("@letta-ai/letta-code");
  });

  test("resolveUpdateRegistryBaseUrl uses default when unset", () => {
    expect(resolveUpdateRegistryBaseUrl({} as NodeJS.ProcessEnv)).toBe(
      "https://registry.npmjs.org",
    );
  });

  test("resolveUpdateRegistryBaseUrl uses valid override", () => {
    expect(
      resolveUpdateRegistryBaseUrl({
        LETTA_UPDATE_REGISTRY_BASE_URL: "http://localhost:4873",
      } as NodeJS.ProcessEnv),
    ).toBe("http://localhost:4873");
  });

  test("resolveUpdateRegistryBaseUrl ignores invalid override", () => {
    expect(
      resolveUpdateRegistryBaseUrl({
        LETTA_UPDATE_REGISTRY_BASE_URL: "javascript:alert(1)",
      } as NodeJS.ProcessEnv),
    ).toBe("https://registry.npmjs.org");
  });

  test("resolveUpdateInstallRegistryUrl returns null when unset", () => {
    expect(resolveUpdateInstallRegistryUrl({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("resolveUpdateInstallRegistryUrl returns valid override", () => {
    expect(
      resolveUpdateInstallRegistryUrl({
        LETTA_UPDATE_INSTALL_REGISTRY_URL: "http://localhost:4873",
      } as NodeJS.ProcessEnv),
    ).toBe("http://localhost:4873");
  });

  test("resolveUpdateInstallRegistryUrl rejects command-substitution-like override", () => {
    expect(
      resolveUpdateInstallRegistryUrl({
        LETTA_UPDATE_INSTALL_REGISTRY_URL: "http://localhost:4873/$(id)",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  test("buildLatestVersionUrl constructs expected endpoint", () => {
    expect(
      buildLatestVersionUrl("@letta-ai/letta-code", "http://localhost:4873/"),
    ).toBe("http://localhost:4873/@letta-ai/letta-code/latest");
  });

  test("buildInstallCommand adds registry when configured", () => {
    expect(
      buildInstallCommand("npm", {
        LETTA_UPDATE_INSTALL_REGISTRY_URL: "http://localhost:4873",
      } as NodeJS.ProcessEnv),
    ).toContain("--registry http://localhost:4873");
  });

  test("buildInstallCommand uses default package and no registry by default", () => {
    expect(buildInstallCommand("pnpm", {} as NodeJS.ProcessEnv)).toBe(
      "pnpm add -g @letta-ai/letta-code@latest",
    );
  });
});

describe("checkForUpdate with fetch", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalRegistry: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalRegistry = process.env.LETTA_UPDATE_REGISTRY_BASE_URL;
    delete process.env.LETTA_UPDATE_REGISTRY_BASE_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRegistry === undefined) {
      delete process.env.LETTA_UPDATE_REGISTRY_BASE_URL;
    } else {
      process.env.LETTA_UPDATE_REGISTRY_BASE_URL = originalRegistry;
    }
  });

  test("returns updateAvailable when registry version differs", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("99.0.0");
    expect(result.checkFailed).toBeUndefined();
  });

  test("returns checkFailed on non-2xx response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(false);
    expect(result.checkFailed).toBe(true);
  });

  test("returns checkFailed on malformed JSON (no version field)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ name: "test" }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(false);
    expect(result.checkFailed).toBe(true);
  });

  test("returns checkFailed on network error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch failed")),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(false);
    expect(result.checkFailed).toBe(true);
  });

  test("uses registry override URL", async () => {
    process.env.LETTA_UPDATE_REGISTRY_BASE_URL = "http://localhost:4873";
    const capturedUrls: string[] = [];
    globalThis.fetch = mock((url: string | URL | Request) => {
      capturedUrls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await checkForUpdate();

    expect(capturedUrls.length).toBe(1);
    expect(capturedUrls[0]).toBe(
      "http://localhost:4873/@letta-ai/letta-code/latest",
    );
  });
});
