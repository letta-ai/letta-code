import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireManualListenerLock,
  getManualListenerScopeHash,
  ManualListenerAlreadyRunningError,
  type ManualListenerLockScope,
  ManualListenerLockUnavailableError,
  normalizeManualListenerServerUrl,
  shouldAcquireManualListenerLock,
} from "@/websocket/listener/manual-instance-lock";

const SCOPE: ManualListenerLockScope = {
  serverUrl: "https://api.letta.com/",
  deviceId: "device-1",
  listenerInstanceId: "server-instance-1",
};

describe("manual listener instance lock", () => {
  let lockRoot: string;
  let alivePids: Set<number>;

  beforeEach(async () => {
    lockRoot = await mkdtemp(path.join(tmpdir(), "letta-listener-lock-"));
    alivePids = new Set();
  });

  afterEach(async () => {
    await rm(lockRoot, { recursive: true, force: true });
  });

  function acquire(
    scope: ManualListenerLockScope,
    processId: number,
    ownerToken: string,
  ) {
    alivePids.add(processId);
    return acquireManualListenerLock(scope, {
      lockRoot,
      processId,
      ownerToken,
      isProcessAlive: (pid) => alivePids.has(pid),
    });
  }

  test("normalizes equivalent server URLs into the same lock scope", () => {
    expect(
      normalizeManualListenerServerUrl(" HTTPS://API.LETTA.COM:443/ "),
    ).toBe("https://api.letta.com");
    expect(getManualListenerScopeHash(SCOPE)).toBe(
      getManualListenerScopeHash({
        ...SCOPE,
        serverUrl: "HTTPS://API.LETTA.COM:443",
      }),
    );
  });

  test("applies only to standalone listeners, not spawner-owned children", () => {
    expect(shouldAcquireManualListenerLock(null, false)).toBe(true);
    expect(
      shouldAcquireManualListenerLock("desktop-primary:installation-1", true),
    ).toBe(false);
    expect(shouldAcquireManualListenerLock(null, true)).toBe(false);
  });

  test("blocks a second live process for the same registration slot", async () => {
    const incumbent = await acquire(SCOPE, 101, "owner-101");

    await expect(acquire(SCOPE, 202, "owner-202")).rejects.toEqual(
      expect.objectContaining({
        name: "ManualListenerAlreadyRunningError",
        holderPid: 101,
      }),
    );

    await incumbent.release();
    const replacement = await acquire(SCOPE, 202, "owner-202-retry");
    await replacement.release();
  });

  test("allows distinct local registration slots to coexist", async () => {
    const handles = await Promise.all([
      acquire(SCOPE, 101, "owner-a"),
      acquire({ ...SCOPE, deviceId: "device-2" }, 102, "owner-b"),
      acquire(
        { ...SCOPE, listenerInstanceId: "server-instance-2" },
        103,
        "owner-c",
      ),
      acquire(
        { ...SCOPE, serverUrl: "https://self-hosted.example.com" },
        104,
        "owner-d",
      ),
    ]);

    await Promise.all(handles.map((handle) => handle.release()));
  });

  test("has exactly one winner across concurrent claims", async () => {
    const claims = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        acquire(SCOPE, 1000 + index, `owner-${index}`),
      ),
    );

    const winners = claims.filter((claim) => claim.status === "fulfilled");
    const losers = claims.filter((claim) => claim.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    for (const loser of losers) {
      if (loser.status === "rejected") {
        expect(loser.reason).toBeInstanceOf(ManualListenerAlreadyRunningError);
      }
    }
    if (winners[0]?.status === "fulfilled") {
      await winners[0].value.release();
    }
  });

  test("reclaims a dead owner without letting its stale release delete the replacement", async () => {
    const stale = await acquire(SCOPE, 101, "owner-stale");
    alivePids.delete(101);

    const replacement = await acquire(SCOPE, 202, "owner-replacement");
    await stale.release();

    await expect(acquire(SCOPE, 303, "owner-third")).rejects.toEqual(
      expect.objectContaining({ holderPid: 202 }),
    );
    await replacement.release();
  });

  test("fails closed on a corrupt incumbent record", async () => {
    const scopeHash = getManualListenerScopeHash(SCOPE);
    const listenersDir = path.join(lockRoot, "listeners");
    await acquireManualListenerLock(SCOPE, {
      lockRoot,
      processId: 101,
      ownerToken: "owner-initial",
      isProcessAlive: () => true,
    }).then(async (handle) => {
      await unlink(handle.lockPath);
      await writeFile(handle.lockPath, "not-json", "utf-8");
    });

    await expect(acquire(SCOPE, 202, "owner-202")).rejects.toBeInstanceOf(
      ManualListenerLockUnavailableError,
    );
    expect(
      await readFile(
        path.join(listenersDir, `manual-${scopeHash}.lock`),
        "utf-8",
      ),
    ).toBe("not-json");
  });

  test("fails closed when the lock root cannot be created", async () => {
    const blockedRoot = path.join(lockRoot, "not-a-directory");
    await writeFile(blockedRoot, "blocked", "utf-8");

    await expect(
      acquireManualListenerLock(SCOPE, {
        lockRoot: blockedRoot,
        processId: 101,
        ownerToken: "owner-101",
        isProcessAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(ManualListenerLockUnavailableError);
  });
});
