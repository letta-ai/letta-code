import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  getGitContextAsync,
  type LightGitContext,
} from "@/cli/helpers/git-context";
import { DeviceGitContextCache } from "./device-git-context";

type PendingLoad = {
  cwd: string;
  resolve: (value: LightGitContext | null) => void;
};

function createPendingLoader(): {
  calls: string[];
  pending: PendingLoad[];
  load: (cwd: string) => Promise<LightGitContext | null>;
} {
  const calls: string[] = [];
  const pending: PendingLoad[] = [];
  return {
    calls,
    pending,
    load: (cwd) => {
      calls.push(cwd);
      return new Promise((resolve) => pending.push({ cwd, resolve }));
    },
  };
}

describe("DeviceGitContextCache", () => {
  test("shares one asynchronous refresh across status requests", async () => {
    const loader = createPendingLoader();
    const cache = new DeviceGitContextCache(loader.load);

    expect(cache.read("/repo")).toBeNull();
    expect(loader.calls).toEqual([]);

    const refresh = cache.refresh("/repo");
    const concurrentRefresh = cache.refresh("/repo");
    expect(loader.calls).toEqual(["/repo"]);
    loader.pending[0]?.resolve({
      branch: "main",
      recent_branches: ["feature"],
    });
    await Promise.all([refresh, concurrentRefresh]);

    expect(cache.read("/repo")).toEqual({
      branch: "main",
      recent_branches: ["feature"],
    });
    expect(loader.calls).toEqual(["/repo"]);
  });

  test("serves stale status while refreshing an expired entry", async () => {
    let now = 0;
    const loader = createPendingLoader();
    const cache = new DeviceGitContextCache(loader.load, () => now);

    const firstRefresh = cache.refresh("/repo");
    loader.pending[0]?.resolve({ branch: "main", recent_branches: [] });
    await firstRefresh;

    now = 15_001;
    expect(cache.read("/repo")).toEqual({
      branch: "main",
      recent_branches: [],
    });
    expect(loader.calls).toEqual(["/repo"]);

    const refresh = cache.refresh("/repo");
    expect(loader.calls).toEqual(["/repo", "/repo"]);
    loader.pending[1]?.resolve({
      branch: "feature",
      recent_branches: ["main"],
    });
    await refresh;
    expect(cache.read("/repo")).toEqual({
      branch: "feature",
      recent_branches: ["main"],
    });
  });

  test("force refresh replaces a valid entry after branch checkout", async () => {
    const loader = createPendingLoader();
    const cache = new DeviceGitContextCache(loader.load);

    const firstRefresh = cache.refresh("/repo");
    loader.pending[0]?.resolve({ branch: "main", recent_branches: [] });
    await firstRefresh;

    const forcedRefresh = cache.refresh("/repo", { force: true });
    expect(loader.calls).toEqual(["/repo", "/repo"]);
    loader.pending[1]?.resolve({
      branch: "feature",
      recent_branches: ["main"],
    });
    await forcedRefresh;

    expect(cache.read("/repo")?.branch).toBe("feature");
  });

  test("a failed load is not cached, so the next refresh retries", async () => {
    let calls = 0;
    const cache = new DeviceGitContextCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error("git timed out");
      return { branch: "main", recent_branches: [] };
    });

    expect(await cache.refresh("/repo")).toBeNull();
    expect(await cache.refresh("/repo")).toEqual({
      branch: "main",
      recent_branches: [],
    });
    expect(calls).toBe(2);
  });

  test.skipIf(process.platform === "win32")(
    "a hung git call times out and does not wedge later refreshes",
    async () => {
      const binDir = await mkdtemp(join(tmpdir(), "letta-hung-git-"));
      const invocations = join(binDir, "invocations");
      const fakeGit = join(binDir, "git");
      await writeFile(
        fakeGit,
        `#!/bin/sh\necho "$1" >> "${invocations}"\nexec sleep 30\n`,
      );
      await chmod(fakeGit, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
      try {
        await expect(
          getGitContextAsync(binDir, { timeoutMs: 100 }),
        ).rejects.toThrow("timed out");

        const cache = new DeviceGitContextCache((cwd) =>
          getGitContextAsync(cwd, { timeoutMs: 100 }),
        );
        const started = Date.now();
        expect(await cache.refresh(binDir)).toBeNull();
        expect(await cache.refresh(binDir)).toBeNull();
        expect(Date.now() - started).toBeLessThan(5_000);

        // Direct call plus one fresh git spawn per cache refresh.
        const lines = (await readFile(invocations, "utf-8")).trim().split("\n");
        expect(lines).toEqual(["rev-parse", "rev-parse", "rev-parse"]);
      } finally {
        process.env.PATH = originalPath;
        await rm(binDir, { recursive: true, force: true });
      }
    },
  );
});
