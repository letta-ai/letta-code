import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimListenerLock,
  getListenerLockPath,
  type ListenerLockHandle,
  releaseListenerLock,
} from "./instance-lock";

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "listener-lock-"));
});

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

function handleOf(
  result: Awaited<ReturnType<typeof claimListenerLock>>,
): ListenerLockHandle {
  if (result.kind !== "acquired") {
    throw new Error(`expected acquired, got ${result.kind}`);
  }
  return result.handle;
}

function writeLock(
  instanceId: string,
  record: { pid: number; lockNonce?: string; acquiredAt?: number },
): string {
  const lockPath = getListenerLockPath(instanceId, lockDir);
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: record.pid,
      listenerInstanceId: instanceId,
      acquiredAt: record.acquiredAt ?? Date.now(),
      lockNonce: record.lockNonce ?? "nonce-existing",
    }),
  );
  return lockPath;
}

describe("claimListenerLock", () => {
  test("acquires a fresh lock and records this process", async () => {
    const result = await claimListenerLock("li-abc", lockDir);
    expect(result.kind).toBe("acquired");
    const record = JSON.parse(readFileSync(handleOf(result).lockPath, "utf-8"));
    expect(record.pid).toBe(process.pid);
    expect(record.listenerInstanceId).toBe("li-abc");
  });

  test("different instance ids never contend (coexistence is the default)", async () => {
    const a = await claimListenerLock("li-a", lockDir);
    const b = await claimListenerLock("li-b", lockDir);
    expect(a.kind).toBe("acquired");
    expect(b.kind).toBe("acquired");
    expect(getListenerLockPath("li-a", lockDir)).not.toBe(
      getListenerLockPath("li-b", lockDir),
    );
  });

  test("reports 'held' with the live holder — and never kills", async () => {
    // A live foreign pid holds the lock. Deps inject liveness so no real
    // signalling of arbitrary pids happens; claimListenerLock has no kill
    // path by design.
    const lockPath = writeLock("li-held", { pid: 4242 });
    const result = await claimListenerLock("li-held", lockDir, {
      isPidAlive: () => true,
    });
    expect(result.kind).toBe("held");
    if (result.kind !== "held") throw new Error("unreachable");
    expect(result.holder.pid).toBe(4242);
    // Lock file untouched — the incumbent still owns it.
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(4242);
  });

  test("a live same-pid holder is 'held' too (double-start within one process fails visibly)", async () => {
    writeLock("li-self", { pid: process.pid });
    const result = await claimListenerLock("li-self", lockDir);
    expect(result.kind).toBe("held");
  });

  test("reclaims a stale lock from a dead pid", async () => {
    writeLock("li-stale", { pid: 4242 });
    const result = await claimListenerLock("li-stale", lockDir, {
      isPidAlive: (pid) => pid === process.pid,
    });
    expect(result.kind).toBe("acquired");
    expect(
      JSON.parse(
        readFileSync(getListenerLockPath("li-stale", lockDir), "utf-8"),
      ).pid,
    ).toBe(process.pid);
  });

  test("reclaims a corrupt lock file", async () => {
    const lockPath = getListenerLockPath("li-corrupt", lockDir);
    writeFileSync(lockPath, "not json");
    const result = await claimListenerLock("li-corrupt", lockDir);
    expect(result.kind).toBe("acquired");
  });

  test("TOCTOU regression: a claimant that captured stale contents cannot remove a FRESH lock republished mid-flight", async () => {
    // Recreates the actual interleaving: B reads stale lock S and decides
    // it is dead; BEFORE B's reclaim proceeds, A reclaims S and publishes
    // fresh lock A'. B's content-keyed claim re-check must then observe
    // the lock no longer contains S, leave A' untouched, and settle as
    // "held" on the fresh holder. The pre-fix implementation removed the
    // lock path unconditionally here and would delete A'.
    const lockPath = writeLock("li-toctou", {
      pid: 999999,
      lockNonce: "stale-gen",
    });
    const staleRaw = readFileSync(lockPath, "utf-8");

    // A': the fresh lock A publishes after winning its reclaim. A live
    // foreign-ish pid (our own, injected as alive) with a new nonce.
    const freshRecord = JSON.stringify({
      pid: process.pid,
      listenerInstanceId: "li-toctou",
      acquiredAt: Date.now(),
      lockNonce: "fresh-gen-A",
    });

    // Drive claimant B. The liveness probe doubles as the interleaving
    // hook: the FIRST probe is B evaluating stale holder 999999 (dead) —
    // at that exact point, before B's reclaim runs, A swaps in its fresh
    // lock. Subsequent probes (fresh holder = our pid) report alive.
    let staleProbes = 0;
    const b = await claimListenerLock("li-toctou", lockDir, {
      isPidAlive: (pid) => {
        if (pid === 999999) {
          staleProbes += 1;
          if (staleProbes === 1) {
            // A wins the race here: reclaim S, publish A'.
            writeFileSync(lockPath, freshRecord);
          }
          return false;
        }
        return true;
      },
    });

    // B captured S, attempted the reclaim, and the claim guard detected
    // the generation change: A's fresh lock survives untouched.
    expect(b.kind).toBe("held");
    if (b.kind !== "held") throw new Error("unreachable");
    expect(b.holder.lockNonce).toBe("fresh-gen-A");
    expect(readFileSync(lockPath, "utf-8")).toBe(freshRecord);
    expect(staleRaw).not.toBe(freshRecord);
  });

  test("stale reclaim is content-keyed: two generations of dead locks reclaim independently", async () => {
    // First stale generation.
    writeLock("li-gen", { pid: 111111, lockNonce: "gen-1" });
    const first = await claimListenerLock("li-gen", lockDir, {
      isPidAlive: (pid) => pid === process.pid,
    });
    expect(first.kind).toBe("acquired");
    await releaseListenerLock(handleOf(first));

    // Second stale generation (different content → different claim key).
    writeLock("li-gen", { pid: 222222, lockNonce: "gen-2" });
    const second = await claimListenerLock("li-gen", lockDir, {
      isPidAlive: (pid) => pid === process.pid,
    });
    expect(second.kind).toBe("acquired");
  });

  test("degrades to 'unavailable' when another live claimant owns the reclaim", async () => {
    const lockPath = writeLock("li-claimed", { pid: 999999 });
    const staleRaw = readFileSync(lockPath, "utf-8");
    // Simulate a live concurrent reclaimer holding the claim for this
    // exact stale content. The claim key is sha256(staleRaw)[:16].
    const { createHash } = await import("node:crypto");
    const claimPath = `${lockPath}.reclaim-${createHash("sha256")
      .update(staleRaw)
      .digest("hex")
      .slice(0, 16)}`;
    writeFileSync(claimPath, JSON.stringify({ pid: process.pid }));

    // Our claim attempt: holder dead, but the reclaim is contended by a
    // live pid (ours). The claimant loops, re-reads the unchanged stale
    // lock, stays contended, and settles as unavailable — never a false
    // acquisition, never deleting the other claimant's state.
    const result = await claimListenerLock("li-claimed", lockDir, {
      isPidAlive: (pid) => pid === process.pid,
    });
    expect(result.kind).toBe("unavailable");
    expect(readFileSync(lockPath, "utf-8")).toBe(staleRaw);
  });

  test("acquisition is atomic: concurrent claimants produce exactly one winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimListenerLock("li-race", lockDir)),
    );
    const acquired = results.filter((r) => r.kind === "acquired");
    const held = results.filter((r) => r.kind === "held");
    // Exactly one claimant wins the hard-link CAS; every loser observes a
    // live holder and reports "held". Nobody concludes "unlocked" while
    // another claim is mid-write, and nobody reclaims a live lock.
    expect(acquired.length).toBe(1);
    expect(held.length).toBe(7);
    const record = JSON.parse(
      readFileSync(getListenerLockPath("li-race", lockDir), "utf-8"),
    );
    expect(record.pid).toBe(process.pid);
    expect(record.listenerInstanceId).toBe("li-race");
  });

  test("returns 'unavailable' instead of throwing when the lock dir is unusable", async () => {
    const fileAsDir = join(lockDir, "not-a-dir");
    writeFileSync(fileAsDir, "x");
    const result = await claimListenerLock("li-x", join(fileAsDir, "sub"));
    expect(result.kind).toBe("unavailable");
  });
});

describe("releaseListenerLock", () => {
  test("removes the generation this handle owns", async () => {
    const result = await claimListenerLock("li-rel", lockDir);
    await releaseListenerLock(handleOf(result));
    expect(() =>
      readFileSync(getListenerLockPath("li-rel", lockDir), "utf-8"),
    ).toThrow();
  });

  test("SAME-PID generation regression: a stale release cannot delete a replacement lock from the same process", async () => {
    // The long-lived TUI case: generation A acquires, ends, generation B
    // (SAME pid, new nonce) acquires the same path. A's stale terminal
    // callback fires late and releases with A's handle — B's lock must
    // survive. A pid-compared release deletes it (the pre-fix bug).
    const a = await claimListenerLock("li-tui", lockDir);
    const aHandle = handleOf(a);
    // Generation B replaces the lock (same pid, new nonce) — as a fresh
    // /listen session would after A ended without releasing.
    const lockPath = getListenerLockPath("li-tui", lockDir);
    const bRecord = JSON.stringify({
      pid: process.pid,
      listenerInstanceId: "li-tui",
      acquiredAt: Date.now(),
      lockNonce: "nonce-generation-B",
    });
    writeFileSync(lockPath, bRecord);

    // A's stale callback fires.
    await releaseListenerLock(aHandle);

    // B's lock survives byte-identical.
    expect(readFileSync(lockPath, "utf-8")).toBe(bRecord);
  });

  test("leaves a different-pid claimant's lock intact", async () => {
    const result = await claimListenerLock("li-newer", lockDir);
    const handle = handleOf(result);
    const lockPath = getListenerLockPath("li-newer", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid + 1,
        listenerInstanceId: "li-newer",
        acquiredAt: Date.now(),
        lockNonce: "nonce-newer",
      }),
    );
    await releaseListenerLock(handle);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(
      process.pid + 1,
    );
  });

  test("is a no-op with a null handle", async () => {
    await releaseListenerLock(null);
    await releaseListenerLock(undefined);
  });

  test("is idempotent for the owning handle", async () => {
    const result = await claimListenerLock("li-idem", lockDir);
    const handle = handleOf(result);
    await releaseListenerLock(handle);
    await releaseListenerLock(handle);
  });
});
