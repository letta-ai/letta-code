import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTestDir } from "@/test-utils/test-fs";
import {
  releaseRemoteSettingsLockSync,
  tryAcquireRemoteSettingsLockSync,
} from "./remote-settings-lock";

describe("remote settings cross-process lock", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (tempRoot) await removeTestDir(tempRoot);
    tempRoot = null;
  });

  test("uses a fresh owner token for every acquisition", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-settings-lock-"));
    const lockPath = path.join(tempRoot, "remote-settings.json.lock");

    const first = tryAcquireRemoteSettingsLockSync(lockPath);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(await readFile(lockPath, "utf-8")).toBe(first.ownerToken);
    releaseRemoteSettingsLockSync(first);

    const second = tryAcquireRemoteSettingsLockSync(lockPath);
    expect(second).not.toBeNull();
    if (!second) return;
    expect(second.ownerToken).not.toBe(first.ownerToken);
    releaseRemoteSettingsLockSync(second);
  });

  test("only treats ESRCH as proof that an owner is dead", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "letta-settings-lock-"));
    const lockPath = path.join(tempRoot, "remote-settings.json.lock");
    await writeFile(lockPath, "99999999-unknown-owner");

    const originalKill = process.kill;
    process.kill = (() => {
      throw Object.assign(new Error("unsupported liveness check"), {
        code: "EINVAL",
      });
    }) as typeof process.kill;
    try {
      expect(tryAcquireRemoteSettingsLockSync(lockPath)).toBeNull();
      expect(await readFile(lockPath, "utf-8")).toBe("99999999-unknown-owner");
    } finally {
      process.kill = originalKill;
    }
  });
});
