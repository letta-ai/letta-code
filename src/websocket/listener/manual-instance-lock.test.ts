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
  let processStartTicks: Map<number, string>;

  beforeEach(async () => {
    lockRoot = await mkdtemp(path.join(tmpdir(), "letta-listener-lock-"));
    alivePids = new Set();
    processStartTicks = new Map();
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
    if (!processStartTicks.has(processId)) {
      processStartTicks.set(processId, `start-${processId}`);
    }
    return acquireManualListenerLock(scope, {
      lockRoot,
      processId,
      ownerToken,
      isProcessAlive: (pid) => alivePids.has(pid),
      readProcessIdentity: (pid) => {
        const startTicks = processStartTicks.get(pid);
        return startTicks
          ? {
              startTicks,
              bootId: "boot-test",
              pidNamespace: "namespace-test",
            }
          : null;
      },
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

  test("reclaims a reused live PID after a container process generation changes", async () => {
    processStartTicks.set(1, "container-generation-a");
    const stale = await acquire(SCOPE, 1, "owner-generation-a");

    processStartTicks.set(1, "container-generation-b");
    const replacement = await acquire(SCOPE, 1, "owner-generation-b");
    await stale.release();

    await expect(acquire(SCOPE, 1, "owner-third")).rejects.toEqual(
      expect.objectContaining({ holderPid: 1 }),
    );
    await replacement.release();
  });

  test("does not steal a fresh lease from a live overlapping PID namespace", async () => {
    const incumbent = await acquireManualListenerLock(SCOPE, {
      lockRoot,
      processId: 1,
      ownerToken: "container-a",
      isProcessAlive: () => true,
      readProcessIdentity: () => ({
        startTicks: "container-a-start",
        bootId: "boot-test",
        pidNamespace: "container-a-namespace",
      }),
    });

    const containerBDeps = {
      lockRoot,
      processId: 1,
      isProcessAlive: () => true,
      readProcessIdentity: () => ({
        startTicks: "container-b-start",
        bootId: "boot-test",
        pidNamespace: "container-b-namespace",
      }),
    };
    await expect(
      acquireManualListenerLock(SCOPE, {
        ...containerBDeps,
        ownerToken: "container-b-overlap",
      }),
    ).rejects.toBeInstanceOf(ManualListenerAlreadyRunningError);

    const replacement = await acquireManualListenerLock(SCOPE, {
      ...containerBDeps,
      ownerToken: "container-b-after-expiry",
      isOwnerHeartbeatFresh: async () => false,
    });
    await incumbent.release();

    await expect(
      acquireManualListenerLock(SCOPE, {
        ...containerBDeps,
        ownerToken: "container-b-third",
      }),
    ).rejects.toBeInstanceOf(ManualListenerAlreadyRunningError);
    await replacement.release();
  });

  test("abandons recovery when an owner renews before unlink", async () => {
    const incumbent = await acquire(SCOPE, 101, "owner-renewing");
    let heartbeatChecks = 0;

    await expect(
      acquireManualListenerLock(SCOPE, {
        lockRoot,
        processId: 202,
        ownerToken: "recovery-contender",
        isProcessAlive: () => true,
        readProcessIdentity: () => ({
          startTicks: "other-process",
          bootId: "boot-test",
          pidNamespace: "other-namespace",
        }),
        isOwnerHeartbeatFresh: async () => {
          heartbeatChecks += 1;
          return heartbeatChecks > 1;
        },
      }),
    ).rejects.toBeInstanceOf(ManualListenerLockUnavailableError);

    expect(heartbeatChecks).toBe(2);
    expect(JSON.parse(await readFile(incumbent.lockPath, "utf-8"))).toEqual(
      expect.objectContaining({ ownerToken: "owner-renewing" }),
    );
    await incumbent.release();
  });

  test("keeps legacy locks without process identity fail-closed", async () => {
    const incumbent = await acquireManualListenerLock(SCOPE, {
      lockRoot,
      processId: 1,
      ownerToken: "legacy-owner",
      isProcessAlive: () => true,
      readProcessIdentity: () => null,
    });
    const legacyRecord = JSON.parse(
      await readFile(incumbent.lockPath, "utf-8"),
    ) as Record<string, unknown>;
    delete legacyRecord.leaseVersion;
    delete legacyRecord.processStartTicks;
    delete legacyRecord.bootId;
    delete legacyRecord.pidNamespace;
    await writeFile(incumbent.lockPath, JSON.stringify(legacyRecord), "utf-8");
    processStartTicks.set(1, "replacement-generation");

    await expect(acquire(SCOPE, 1, "replacement-owner")).rejects.toEqual(
      expect.objectContaining({ holderPid: 1 }),
    );
    await incumbent.release();
  });

  test("fails closed on a corrupt incumbent record", async () => {
    const scopeHash = getManualListenerScopeHash(SCOPE);
    const listenersDir = path.join(lockRoot, "listeners");
    const incumbent = await acquireManualListenerLock(SCOPE, {
      lockRoot,
      processId: 101,
      ownerToken: "owner-initial",
      isProcessAlive: () => true,
    });
    await unlink(incumbent.lockPath);
    await writeFile(incumbent.lockPath, "not-json", "utf-8");
    await incumbent.release();

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
