/**
 * Cross-process refresh coordination, exercised with real subprocesses.
 *
 * The other refresh tests all run in one process, so they only ever prove the
 * in-process layers work. This spawns N `bun` workers that each call
 * `refreshTokensCoordinated` against one shared credential file and one shared
 * lockfile, and counts how many actually reached the refresh call.
 *
 * Oracle: refresh-count.txt holds one byte per refresh. With the shared lock
 * it must contain exactly 1.
 *
 * A barrier is what keeps this honest. Without one, worker A can finish the
 * whole refresh before worker B starts and the test would pass with no lock at
 * all. Two barrier placements are needed because reads happen inside the
 * critical section:
 *
 *   • start barrier — releases all workers together just before they contend,
 *     used for the locked case. A barrier inside the read would deadlock there,
 *     with the lock holder waiting on workers blocked on the lock.
 *   • load barrier — holds every worker until all have read, used only by the
 *     unlocked control to stop the losers from adopting the winner's rotation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REFRESH_MODULE = join(import.meta.dir, "oauth-refresh.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");

const tempDirs: string[] = [];

function makeShareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-refresh-multiproc-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Worker body. Stores the credential as one JSON file so the whole record
 * rotates atomically. readTokens maps it onto the durable-snapshot shape the
 * coordinator consumes (source "file" = authoritative and verifiable).
 */
const WORKER_SCRIPT = `
const { refreshTokensCoordinated } = await import(process.env.REFRESH_MODULE);
const { appendFileSync, readFileSync, writeFileSync, statSync } = await import("node:fs");
const { join } = await import("node:path");

const shareDir = process.env.SHARE_DIR;
const credentialPath = join(shareDir, "credential.json");
const counterPath = join(shareDir, "refresh-count.txt");
const readyPath = join(shareDir, "first-load-ready.txt");
const workerCount = Number(process.env.WORKER_COUNT);

/**
 * Block until every worker has reached this point.
 *
 * This must sit before the refresh call, not inside readTokens: the
 * coordinated lifecycle reads storage only while holding the lock, so a
 * barrier in the read would have the lock holder waiting on workers that are
 * themselves blocked on the lock.
 */
function waitForBarrier(label) {
  appendFileSync(readyPath, ".");
  const deadline = Date.now() + 10000;
  for (;;) {
    let ready = 0;
    try { ready = statSync(readyPath).size; } catch {}
    if (ready >= workerCount) return;
    if (Date.now() >= deadline) throw new Error(label + " barrier timed out");
    Bun.sleepSync(5);
  }
}

let firstLoad = true;
async function readTokens() {
  let record = null;
  try {
    record = JSON.parse(readFileSync(credentialPath, "utf8"));
  } catch {
    record = null;
  }
  // Control mode only: hold every worker until all have read, so none can see
  // a peer's rotation. Deadlocks under a shared lock, where reads happen
  // inside the critical section — hence the separate start barrier there.
  if (process.env.LOAD_BARRIER === "1" && firstLoad) {
    firstLoad = false;
    waitForBarrier("load");
  }
  return {
    apiKey: record?.accessToken ?? null,
    refreshToken: record?.refreshToken ?? null,
    tokenExpiresAt: record?.expiresAt ?? null,
    source: "file",
  };
}

async function persist(updates) {
  writeFileSync(credentialPath, JSON.stringify({
    accessToken: updates.env.LETTA_API_KEY,
    refreshToken: updates.refreshToken,
    expiresAt: updates.tokenExpiresAt,
  }), "utf8");
}

// One byte per refresh; O_APPEND is atomic on POSIX.
async function refresh() {
  appendFileSync(counterPath, ".");
  const stamp = String(Date.now()) + "-" + String(process.pid);
  return {
    access_token: "at-" + stamp,
    refresh_token: "rt-rotated-" + stamp,
    token_type: "Bearer",
    expires_in: 3600,
  };
}

try {
  if (process.env.BARRIER === "1") waitForBarrier("start");
  const accessToken = await refreshTokensCoordinated("rt-initial", {
    lockPath: process.env.LOCK_PATH,
    readTokens,
    persist,
    refresh,
  });
  process.stdout.write("ok:" + accessToken + "\\n");
} catch (error) {
  process.stdout.write("err:" + (error?.message ?? String(error)) + "\\n");
}
`;

/** Seed a credential that is inside the refresh window, so a refresh is due. */
function seedStaleCredential(shareDir: string): void {
  writeFileSync(
    join(shareDir, "credential.json"),
    JSON.stringify({
      accessToken: "at-initial",
      refreshToken: "rt-initial",
      expiresAt: Date.now() + 60_000,
    }),
    "utf8",
  );
}

function refreshCount(shareDir: string): number {
  try {
    return statSync(join(shareDir, "refresh-count.txt")).size;
  } catch {
    return 0;
  }
}

interface WorkerOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawnWorkers(options: {
  shareDir: string;
  count: number;
  /** Per-worker lock path. A shared path serializes; distinct paths do not. */
  lockPathFor: (id: number) => string;
  /** Release all workers together just before they contend for the lock. */
  barrier: boolean;
  /** Control only: hold all workers until each has read the credential. */
  loadBarrier?: boolean;
}): Promise<WorkerOutcome[]> {
  const scriptPath = join(options.shareDir, "worker.mjs");
  writeFileSync(scriptPath, WORKER_SCRIPT, "utf8");

  const running = Array.from({ length: options.count }, (_unused, id) =>
    Bun.spawn(["bun", scriptPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        REFRESH_MODULE: REFRESH_MODULE,
        SHARE_DIR: options.shareDir,
        LOCK_PATH: options.lockPathFor(id),
        WORKER_COUNT: String(options.count),
        BARRIER: options.barrier ? "1" : "0",
        LOAD_BARRIER: options.loadBarrier ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );

  return await Promise.all(
    running.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    }),
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("refreshTokensCoordinated across processes", () => {
  test("four concurrent processes produce exactly one refresh", async () => {
    const shareDir = makeShareDir();
    seedStaleCredential(shareDir);
    const lockPath = join(shareDir, "oauth-refresh");

    const workers = await spawnWorkers({
      shareDir,
      count: 4,
      lockPathFor: () => lockPath,
      barrier: true,
    });

    for (const worker of workers) {
      expect(worker.stdout.startsWith("ok:"), worker.stderr).toBe(true);
      expect(worker.exitCode).toBe(0);
    }
    expect(refreshCount(shareDir)).toBe(1);
  }, 60_000);

  test("interleaved reads without a shared lock refresh once per process", async () => {
    // Control, so the assertion above cannot pass vacuously.
    //
    // Unshared locks alone are not enough to show the difference: the winner
    // persists its rotation fast enough that the losers read it and adopt it,
    // so storage coalesces them even with no lock. Holding every worker until
    // all four have read is what actually reproduces the unsynchronized case,
    // and then each one spends the same refresh_token.
    const shareDir = makeShareDir();
    seedStaleCredential(shareDir);

    const workers = await spawnWorkers({
      shareDir,
      count: 4,
      lockPathFor: (id) => join(shareDir, `unshared-${String(id)}`),
      barrier: false,
      loadBarrier: true,
    });

    for (const worker of workers) {
      expect(worker.stdout.startsWith("ok:"), worker.stderr).toBe(true);
    }
    expect(refreshCount(shareDir)).toBeGreaterThan(1);
  }, 60_000);

  test("a lock abandoned by a dead process does not wedge the next one", async () => {
    const shareDir = makeShareDir();
    seedStaleCredential(shareDir);
    const lockPath = join(shareDir, "oauth-refresh");
    // proper-lockfile locks are directories reaped by mtime staleness. A live
    // holder touches the mtime continuously; backdating it simulates a holder
    // that died without releasing.
    const abandonedLockDir = `${lockPath}.lock`;
    mkdirSync(abandonedLockDir);
    const past = new Date(Date.now() - 60_000);
    utimesSync(abandonedLockDir, past, past);

    const [worker] = await spawnWorkers({
      shareDir,
      count: 1,
      lockPathFor: () => lockPath,
      barrier: false,
    });

    expect(worker?.stdout.startsWith("ok:"), worker?.stderr).toBe(true);
    expect(refreshCount(shareDir)).toBe(1);
  }, 60_000);
});
