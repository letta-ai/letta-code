import { describe, expect, test } from "bun:test";
import type { LightGitContext } from "@/cli/helpers/git-context";
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
});
