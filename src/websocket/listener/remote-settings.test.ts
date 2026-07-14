import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getRemoteSettingsPath,
  loadRemoteSettings,
  resetRemoteSettingsCache,
  saveRemoteSettings,
} from "./remote-settings";

describe("remote settings cwd repair", () => {
  const originalHome = process.env.HOME;
  let tempRoot: string | null = null;

  afterEach(async () => {
    resetRemoteSettingsCache();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  test("durably removes stale and non-directory cwd entries during startup", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    const fakeHome = path.join(tempRoot, "home");
    const liveDirectory = path.join(tempRoot, "live");
    const deletedDirectory = path.join(tempRoot, "deleted-worktree");
    const regularFile = path.join(tempRoot, "not-a-directory");
    process.env.HOME = fakeHome;

    await mkdir(path.dirname(getRemoteSettingsPath()), { recursive: true });
    await mkdir(liveDirectory);
    await writeFile(regularFile, "not a directory");
    await writeFile(
      getRemoteSettingsPath(),
      JSON.stringify({
        cwdMap: {
          "conversation:live": liveDirectory,
          "conversation:stale": deletedDirectory,
          "conversation:file": regularFile,
        },
        permissionModeMap: {
          "conversation:live": { mode: "standard" },
        },
      }),
    );

    expect(loadRemoteSettings()).toEqual({
      cwdMap: { "conversation:live": liveDirectory },
      permissionModeMap: {
        "conversation:live": { mode: "standard" },
      },
    });

    const repairedOnDisk = JSON.parse(
      await readFile(getRemoteSettingsPath(), "utf-8"),
    );
    expect(repairedOnDisk.cwdMap).toEqual({
      "conversation:live": liveDirectory,
    });

    // Reusing the deleted filesystem path must not resurrect its old scope.
    await mkdir(deletedDirectory);
    resetRemoteSettingsCache();
    expect(loadRemoteSettings().cwdMap).toEqual({
      "conversation:live": liveDirectory,
    });
  });

  test("persists each update before returning", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");

    saveRemoteSettings({
      cwdMap: { "conversation:stale": "/deleted/worktree" },
    });
    saveRemoteSettings({
      cwdMap: { "conversation:live": "/repository/root" },
    });

    const persisted = JSON.parse(
      readFileSync(getRemoteSettingsPath(), "utf-8"),
    );
    expect(persisted.cwdMap).toEqual({
      "conversation:live": "/repository/root",
    });
  });
});
