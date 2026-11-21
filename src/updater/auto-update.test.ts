import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireUpdateLock,
  buildInstallCommand,
  buildLatestVersionUrl,
  buildUpdateExecOptions,
  checkAndAutoUpdate,
  checkForUpdate,
  cleanupOrphanedDirs,
  detectPackageManager,
  getSelfUpdateStatus,
  manualUpdate,
  resolveUpdateInstallRegistryUrl,
  resolveUpdatePackageName,
  resolveUpdateRegistryBaseUrl,
} from "@/updater/auto-update";

test("Python wheels never query npm or self-install updates", async () => {
  const previous = process.env.LETTA_CODE_DISTRIBUTION;
  process.env.LETTA_CODE_DISTRIBUTION = "pypi";
  try {
    const fetchImpl = mock(() => {
      throw new Error("Python distribution must not contact npm");
    });
    expect(
      (await checkForUpdate(fetchImpl as unknown as typeof fetch))
        .updateAvailable,
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await checkAndAutoUpdate()).toBeUndefined();
    expect(getSelfUpdateStatus().supported).toBe(false);
    expect(getSelfUpdateStatus().manual_command).toContain(
      "uv tool upgrade letta",
    );
    expect(await manualUpdate()).toEqual({
      success: false,
      message: getSelfUpdateStatus().manual_command,
    });
  } finally {
    if (previous === undefined) delete process.env.LETTA_CODE_DISTRIBUTION;
    else process.env.LETTA_CODE_DISTRIBUTION = previous;
  }
});

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

  describe("cleanupOrphanedDirs", () => {
    for (const platform of ["win32", "linux"] as const) {
      test(`${platform}: cleans the npm root only when a complete replacement exists`, async () => {
        const scope = path.join(
          testDir,
          ...(platform === "win32" ? [] : ["lib"]),
          "node_modules",
          "@letta-ai",
        );
        const backup = path.join(scope, ".letta-code-abc123");
        const live = path.join(scope, "letta-code");
        const other = path.join(scope, "other-package");
        fs.mkdirSync(other, { recursive: true });
        for (const dir of [backup, live]) {
          fs.mkdirSync(path.join(dir, "node_modules", "dependency"), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(dir, "package.json"),
            '{"name":"@letta-ai/letta-code"}',
          );
          fs.writeFileSync(path.join(dir, "letta.js"), "// intact CLI");
          fs.writeFileSync(
            path.join(dir, "node_modules", "dependency", "index.js"),
            "// dependency",
          );
        }
        await cleanupOrphanedDirs(testDir, platform);
        expect(fs.existsSync(backup)).toBe(false);
        expect(fs.existsSync(path.join(live, "letta.js"))).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
      });

      for (const missing of [
        "entire install",
        "package.json",
        "letta.js",
        "node_modules/dependency/index.js",
        "empty entry",
      ]) {
        test(`${platform}: retains the only intact backup with ${missing} missing/incomplete`, async () => {
          const scope = path.join(
            testDir,
            ...(platform === "win32" ? [] : ["lib"]),
            "node_modules",
            "@letta-ai",
          );
          const backup = path.join(scope, ".letta-code-abc123");
          const live = path.join(scope, "letta-code");
          for (const dir of [backup, live]) {
            fs.mkdirSync(path.join(dir, "node_modules", "dependency"), {
              recursive: true,
            });
            fs.writeFileSync(
              path.join(dir, "package.json"),
              '{"name":"@letta-ai/letta-code"}',
            );
            fs.writeFileSync(path.join(dir, "letta.js"), "// intact CLI");
            fs.writeFileSync(
              path.join(dir, "node_modules", "dependency", "index.js"),
              "// dependency",
            );
          }
          if (missing === "empty entry")
            fs.writeFileSync(path.join(live, "letta.js"), "");
          else
            fs.rmSync(
              missing === "entire install" ? live : path.join(live, missing),
              { recursive: true },
            );
          await cleanupOrphanedDirs(testDir, platform);
          expect(fs.readFileSync(path.join(backup, "letta.js"), "utf8")).toBe(
            "// intact CLI",
          );
        });
      }
    }

    test("ignores a missing npm scope", async () => {
      await cleanupOrphanedDirs(testDir);
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

describe("getSelfUpdateStatus", () => {
  let originalArgv1: string;
  let originalDesktopManaged: string | undefined;

  beforeEach(() => {
    originalArgv1 = process.argv[1] || "";
    originalDesktopManaged = process.env.LETTA_CODE_DESKTOP_MANAGED;
    delete process.env.LETTA_CODE_DESKTOP_MANAGED;
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    if (originalDesktopManaged !== undefined) {
      process.env.LETTA_CODE_DESKTOP_MANAGED = originalDesktopManaged;
    } else {
      delete process.env.LETTA_CODE_DESKTOP_MANAGED;
    }
  });

  test("disables self-update for packaged Desktop runtimes", () => {
    process.argv[1] =
      "/Applications/Letta.app/Contents/Resources/app.asar.unpacked/node_modules/@letta-ai/letta-code/letta.js";

    const status = getSelfUpdateStatus();

    expect(status.supported).toBe(false);
    expect(status.writable).toBe(false);
    expect(status.reason).toContain("managed by Letta Code Desktop");
    expect(status.manual_command).toBe(
      "Update Letta Code Desktop to upgrade the bundled Letta Code runtime.",
    );
  });

  test("disables self-update when Desktop marks the runtime as managed", () => {
    process.env.LETTA_CODE_DESKTOP_MANAGED = "1";
    process.argv[1] =
      "/Users/test/.nvm/versions/node/v20.10.0/lib/node_modules/@letta-ai/letta-code/dist/index.js";

    const status = getSelfUpdateStatus();

    expect(status.supported).toBe(false);
    expect(status.writable).toBe(false);
    expect(status.reason).toContain("managed by Letta Code Desktop");
  });
});

describe("update config resolution", () => {
  test("install commands default to no timeout, while prefix queries stay bounded", () => {
    expect(buildUpdateExecOptions().timeout).toBe(0);
    expect(buildUpdateExecOptions(5000).timeout).toBe(5000);
  });

  test("buildUpdateExecOptions enables shell on Windows for npm.cmd shims", () => {
    expect(buildUpdateExecOptions(5000, "win32")).toEqual({
      timeout: 5000,
      encoding: "utf8",
      shell: true,
    });
  });

  test("buildUpdateExecOptions keeps direct execFile behavior off Windows", () => {
    expect(buildUpdateExecOptions(60000, "darwin")).toEqual({
      timeout: 60000,
      encoding: "utf8",
      shell: false,
    });
  });

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
  let originalRegistry: string | undefined;

  beforeEach(() => {
    originalRegistry = process.env.LETTA_UPDATE_REGISTRY_BASE_URL;
    delete process.env.LETTA_UPDATE_REGISTRY_BASE_URL;
  });

  afterEach(() => {
    if (originalRegistry === undefined) {
      delete process.env.LETTA_UPDATE_REGISTRY_BASE_URL;
    } else {
      process.env.LETTA_UPDATE_REGISTRY_BASE_URL = originalRegistry;
    }
  });

  test("returns updateAvailable when registry version differs", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate(fetchMock);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("99.0.0");
    expect(result.checkFailed).toBeUndefined();
  });

  test("returns checkFailed on non-2xx response", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate(fetchMock);
    expect(result.updateAvailable).toBe(false);
    expect(result.checkFailed).toBe(true);
  });

  test("returns checkFailed on malformed JSON (no version field)", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ name: "test" }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate(fetchMock);
    expect(result.updateAvailable).toBe(false);
    expect(result.checkFailed).toBe(true);
  });

  test("returns checkFailed on network error", async () => {
    const fetchMock = mock(() =>
      Promise.reject(new Error("fetch failed")),
    ) as unknown as typeof fetch;

    const result = await checkForUpdate(fetchMock);
    expect(result.updateAvailable).toBe(false);
    expect(result.checkFailed).toBe(true);
  });

  test("uses registry override URL", async () => {
    process.env.LETTA_UPDATE_REGISTRY_BASE_URL = "http://localhost:4873";
    const capturedUrls: string[] = [];
    const fetchMock = mock((url: string | URL | Request) => {
      capturedUrls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await checkForUpdate(fetchMock);

    expect(capturedUrls.length).toBe(1);
    expect(capturedUrls[0]).toBe(
      "http://localhost:4873/@letta-ai/letta-code/latest",
    );
  });
});

describe("checkAndAutoUpdate install guards", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "LETTA_CODE_AGENT_ROLE",
    "LETTA_PACKAGE_MANAGER",
    "DISABLE_AUTOUPDATER",
    "LETTA_CODE_DISTRIBUTION",
    "LETTA_UPDATE_REGISTRY_BASE_URL",
  ];
  let originalArgv1: string;
  let testDir: string;
  let lockPath: string;
  // Far above any real pid limit, so it is never alive.
  const deadPid = 2 ** 30;

  const fetchImpl = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
    ),
  ) as unknown as typeof fetch;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // bun skips the npm-only prefix lookup, so every command is the install.
    process.env.LETTA_PACKAGE_MANAGER = "bun";
    originalArgv1 = process.argv[1] || "";
    process.argv[1] =
      "/usr/local/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "letta-update-lock-"));
    lockPath = path.join(testDir, "auto-update.lock");
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.argv[1] = originalArgv1;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function installMock() {
    return mock(() => Promise.resolve({ stdout: "", stderr: "" }));
  }

  test("subagent processes never check for or install updates", async () => {
    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
    const runCommand = installMock();
    const fetchSpy = mock(fetchImpl);

    const result = await checkAndAutoUpdate({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      runCommand,
      lockPath,
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("installs and releases the lock when no other update is running", async () => {
    const runCommand = installMock();

    await checkAndAutoUpdate({ fetchImpl, runCommand, lockPath });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("skips the install while a live process holds the lock", async () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60 * 60e3 }),
    );
    const runCommand = installMock();

    const result = await checkAndAutoUpdate({
      fetchImpl,
      runCommand,
      lockPath,
    });

    expect(result).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
    // The holder's lock is left alone.
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });

  test("skips the install while a recent lock exists, even from a dead pid", async () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, createdAt: Date.now() }),
    );
    const runCommand = installMock();

    await checkAndAutoUpdate({ fetchImpl, runCommand, lockPath });

    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test("takes over a stale lock from a dead pid", async () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60 * 60e3 }),
    );
    const runCommand = installMock();

    await checkAndAutoUpdate({ fetchImpl, runCommand, lockPath });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("two takeovers of the same stale lock yield exactly one owner", async () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60 * 60e3 }),
    );

    const results = await Promise.all([
      acquireUpdateLock(lockPath),
      acquireUpdateLock(lockPath),
    ]);
    const winners = results.filter((release) => release !== null);

    expect(winners).toHaveLength(1);
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.createdAt).toBeGreaterThan(Date.now() - 60e3);
    // The stale lock moved aside during takeover is cleaned up.
    expect(fs.readdirSync(testDir)).toEqual(["auto-update.lock"]);

    winners[0]?.();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("an error while acquiring the lock skips the install", async () => {
    // The lock's parent is a regular file, so the lock can never be created.
    const blocker = path.join(testDir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const runCommand = installMock();

    const result = await checkAndAutoUpdate({
      fetchImpl,
      runCommand,
      lockPath: path.join(blocker, "auto-update.lock"),
    });

    expect(result).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("concurrent update checks run a single install", async () => {
    let finishInstall: () => void = () => {};
    const installDone = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const runCommand = mock(async () => {
      await installDone;
      return { stdout: "", stderr: "" };
    });

    const first = checkAndAutoUpdate({ fetchImpl, runCommand, lockPath });
    while (runCommand.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await checkAndAutoUpdate({ fetchImpl, runCommand, lockPath });
    finishInstall();
    await first;

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
