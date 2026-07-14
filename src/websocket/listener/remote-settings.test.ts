import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  flushRemoteSettingsWrites,
  getRemoteSettingsPath,
  loadRemoteSettings,
  resetRemoteSettingsCache,
  saveRemoteSettings,
  saveRemoteSettingsSync,
} from "./remote-settings";

describe("remote settings cwd repair", () => {
  const originalHome = process.env.HOME;
  let tempRoot: string | null = null;

  afterEach(async () => {
    resetRemoteSettingsCache();
    await flushRemoteSettingsWrites();
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

  test("persists an empty legacy migration so stale entries cannot resurrect", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    const fakeHome = path.join(tempRoot, "home");
    const deletedDirectory = path.join(tempRoot, "deleted-worktree");
    process.env.HOME = fakeHome;

    const legacyPath = path.join(fakeHome, ".letta", "cwd-cache.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({ "conversation:stale": deletedDirectory }),
    );

    expect(loadRemoteSettings().cwdMap).toEqual({});
    expect(
      JSON.parse(await readFile(getRemoteSettingsPath(), "utf-8")),
    ).toEqual({ cwdMap: {} });

    await mkdir(deletedDirectory);
    resetRemoteSettingsCache();
    expect(loadRemoteSettings().cwdMap).toEqual({});
  });

  test("coalesces asynchronous updates while preserving merged settings", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");

    saveRemoteSettings({
      cwdMap: { "conversation:stale": "/deleted/worktree" },
    });
    saveRemoteSettings({
      cwdMap: { "conversation:live": "/repository/root" },
    });
    await flushRemoteSettingsWrites();

    const persisted = JSON.parse(
      readFileSync(getRemoteSettingsPath(), "utf-8"),
    );
    expect(persisted.cwdMap).toEqual({
      "conversation:live": "/repository/root",
    });
  });

  test("synchronous cwd repair fences a pending permission snapshot", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");

    saveRemoteSettings({
      cwdMap: { "conversation:stale": "/deleted/worktree" },
    });
    saveRemoteSettings({
      permissionModeMap: {
        "conversation:live": { mode: "unrestricted" },
      },
    });
    saveRemoteSettingsSync({
      cwdMap: { "conversation:live": "/repository/root" },
    });
    await flushRemoteSettingsWrites();

    const persisted = JSON.parse(
      readFileSync(getRemoteSettingsPath(), "utf-8"),
    );
    expect(persisted).toMatchObject({
      cwdMap: { "conversation:live": "/repository/root" },
      permissionModeMap: {
        "conversation:live": { mode: "unrestricted" },
      },
    });
  });

  test("retries an unchanged snapshot after a transient write failure", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    const fakeHome = path.join(tempRoot, "home");
    process.env.HOME = fakeHome;

    await mkdir(fakeHome);
    await writeFile(path.join(fakeHome, ".letta"), "temporarily blocked");

    const updates = {
      cwdMap: { "conversation:live": "/repository/root" },
    };
    saveRemoteSettings(updates);
    expect(await flushRemoteSettingsWrites()).toBe(false);

    await rm(path.join(fakeHome, ".letta"));
    await mkdir(path.join(fakeHome, ".letta"));

    saveRemoteSettings(updates);
    expect(await flushRemoteSettingsWrites()).toBe(true);
    expect(
      JSON.parse(await readFile(getRemoteSettingsPath(), "utf-8")),
    ).toEqual(updates);
  });

  test("recovers a dead process lock before persisting", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");

    const lockPath = `${getRemoteSettingsPath()}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "99999999-dead-owner");

    saveRemoteSettings({
      cwdMap: { "conversation:live": "/repository/root" },
    });
    expect(await flushRemoteSettingsWrites()).toBe(true);
    expect(
      JSON.parse(await readFile(getRemoteSettingsPath(), "utf-8")),
    ).toEqual({ cwdMap: { "conversation:live": "/repository/root" } });
  });

  test("takes over an abandoned stale-lock recovery claim", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");

    const lockPath = `${getRemoteSettingsPath()}.lock`;
    const deadToken = "99999999-dead-owner";
    const tokenHash = createHash("sha256").update(deadToken).digest("hex");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, deadToken);
    await writeFile(
      `${lockPath}.recover.${tokenHash}.0`,
      "99999998-dead-recovery-owner",
    );

    saveRemoteSettings({
      permissionModeMap: { "conversation:live": { mode: "acceptEdits" } },
    });
    expect(await flushRemoteSettingsWrites()).toBe(true);
    expect(
      JSON.parse(await readFile(getRemoteSettingsPath(), "utf-8")),
    ).toMatchObject({
      cwdMap: {},
      permissionModeMap: {
        "conversation:live": { mode: "acceptEdits" },
      },
    });
  });

  test("replays a cwd deletion after shutdown lock contention", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");
    const settingsPath = getRemoteSettingsPath();
    const staleDirectory = path.join(tempRoot, "recreated-worktree");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(staleDirectory);
    await writeFile(
      settingsPath,
      JSON.stringify({
        cwdMap: { "conversation:stale": staleDirectory },
      }),
    );

    resetRemoteSettingsCache();
    expect(loadRemoteSettings().cwdMap).toEqual({
      "conversation:stale": staleDirectory,
    });
    await rm(staleDirectory, { recursive: true });
    await writeFile(`${settingsPath}.lock`, `${process.pid}-foreign-owner`);

    saveRemoteSettingsSync({ cwdMap: {} });
    expect(await flushRemoteSettingsWrites()).toBe(false);
    expect(JSON.parse(await readFile(settingsPath, "utf-8")).cwdMap).toEqual({
      "conversation:stale": staleDirectory,
    });
    expect(
      (await readdir(path.dirname(settingsPath))).some((name) =>
        name.includes(".cwd-repair."),
      ),
    ).toBe(true);

    await rm(`${settingsPath}.lock`);
    await mkdir(staleDirectory);
    resetRemoteSettingsCache();
    expect(loadRemoteSettings().cwdMap).toEqual({});
    expect(await flushRemoteSettingsWrites()).toBe(true);
    expect(JSON.parse(await readFile(settingsPath, "utf-8")).cwdMap).toEqual(
      {},
    );
    expect(
      (await readdir(path.dirname(settingsPath))).some((name) =>
        name.includes(".cwd-repair."),
      ),
    ).toBe(false);
  });

  test("does not replay a repair already fenced in settings", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");
    const settingsPath = getRemoteSettingsPath();
    const restoredDirectory = path.join(tempRoot, "explicitly-restored");
    const repairId = "repair-applied-before-crash";
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(restoredDirectory);
    await writeFile(
      settingsPath,
      JSON.stringify({
        cwdMap: { "conversation:restored": restoredDirectory },
        cwdRepairJournalIds: [repairId],
      }),
    );
    await writeFile(
      `${settingsPath}.cwd-repair.${repairId}.json`,
      JSON.stringify({
        cwdDeletes: { "conversation:restored": restoredDirectory },
        id: repairId,
      }),
    );

    resetRemoteSettingsCache();
    expect(loadRemoteSettings().cwdMap).toEqual({
      "conversation:restored": restoredDirectory,
    });
    expect(await flushRemoteSettingsWrites()).toBe(true);
    expect(JSON.parse(await readFile(settingsPath, "utf-8")).cwdMap).toEqual({
      "conversation:restored": restoredDirectory,
    });
    expect(
      (await readdir(path.dirname(settingsPath))).some((name) =>
        name.includes(".cwd-repair."),
      ),
    ).toBe(false);
  });

  test("replays a fully written repair temp after a pre-rename crash", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    process.env.HOME = path.join(tempRoot, "home");
    const settingsPath = getRemoteSettingsPath();
    const recreatedDirectory = path.join(tempRoot, "recreated-before-replay");
    const repairId = "repair-temp-before-rename";
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(recreatedDirectory);
    await writeFile(
      settingsPath,
      JSON.stringify({
        cwdMap: { "conversation:stale": recreatedDirectory },
      }),
    );
    await writeFile(
      `${settingsPath}.cwd-repair.${repairId}.json.123.tmp`,
      JSON.stringify({
        cwdDeletes: { "conversation:stale": recreatedDirectory },
        id: repairId,
      }),
    );

    resetRemoteSettingsCache();
    expect(loadRemoteSettings().cwdMap).toEqual({});
    expect(await flushRemoteSettingsWrites()).toBe(true);
    expect(JSON.parse(await readFile(settingsPath, "utf-8")).cwdMap).toEqual(
      {},
    );
  });

  test("merges entry patches with settings written by another listener", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-remote-settings-"));
    const fakeHome = path.join(tempRoot, "home");
    const localDirectory = path.join(tempRoot, "local");
    const nextLocalDirectory = path.join(tempRoot, "local-next");
    const externalDirectory = path.join(tempRoot, "external");
    process.env.HOME = fakeHome;

    await mkdir(path.dirname(getRemoteSettingsPath()), { recursive: true });
    await Promise.all([
      mkdir(localDirectory),
      mkdir(nextLocalDirectory),
      mkdir(externalDirectory),
    ]);
    await writeFile(
      getRemoteSettingsPath(),
      JSON.stringify({
        cwdMap: { "conversation:local": localDirectory },
        permissionModeMap: {
          "conversation:shared": { mode: "standard" },
        },
      }),
    );
    loadRemoteSettings();

    // Simulate another listener publishing after this process populated its
    // cache. Its unrelated map entry and permission update must survive.
    await writeFile(
      getRemoteSettingsPath(),
      JSON.stringify({
        cwdMap: {
          "conversation:local": localDirectory,
          "conversation:external": externalDirectory,
        },
        permissionModeMap: {
          "conversation:shared": { mode: "unrestricted" },
        },
      }),
    );

    await mkdir(`${getRemoteSettingsPath()}.lock`);
    saveRemoteSettingsSync({
      cwdMap: { "conversation:local": nextLocalDirectory },
    });
    await rm(`${getRemoteSettingsPath()}.lock`, { recursive: true });
    expect(await flushRemoteSettingsWrites()).toBe(true);

    expect(
      JSON.parse(await readFile(getRemoteSettingsPath(), "utf-8")),
    ).toEqual({
      cwdMap: {
        "conversation:local": nextLocalDirectory,
        "conversation:external": externalDirectory,
      },
      permissionModeMap: {
        "conversation:shared": { mode: "unrestricted" },
      },
    });

    // A stale deletion must not remove a same-key reassignment published by
    // another listener after this process last saw the entry.
    await writeFile(
      getRemoteSettingsPath(),
      JSON.stringify({
        cwdMap: {
          "conversation:local": externalDirectory,
          "conversation:external": externalDirectory,
        },
        permissionModeMap: {
          "conversation:shared": { mode: "unrestricted" },
        },
      }),
    );
    saveRemoteSettingsSync({ cwdMap: {} });
    expect(await flushRemoteSettingsWrites()).toBe(true);
    expect(
      JSON.parse(await readFile(getRemoteSettingsPath(), "utf-8")),
    ).toMatchObject({
      cwdMap: {
        "conversation:local": externalDirectory,
        "conversation:external": externalDirectory,
      },
      permissionModeMap: {
        "conversation:shared": { mode: "unrestricted" },
      },
    });
  });
});
