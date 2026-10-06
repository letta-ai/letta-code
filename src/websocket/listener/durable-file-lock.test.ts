import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDurableFileLock,
  type DurableLockOwner,
  durableLockOwnerIsAlive,
  fsyncDirectory,
  getProcessStart,
} from "./durable-file-lock";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "letta-durable-lock-"));
  const path = join(root, "state.json");
  const lock = `${path}.lock`;
  const marker = `${lock}.recovery`;
  const owners = `${lock}-owners`;
  mkdirSync(owners, { recursive: true });
  const install = (owner: DurableLockOwner, destination: string) => {
    const ownerPath = join(owners, `${owner.pid}-${owner.token}.json`);
    if (!existsSync(ownerPath)) {
      writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    }
    linkSync(ownerPath, destination);
    return ownerPath;
  };
  return { root, path, lock, marker, owners, install };
}

const deadOwner: DurableLockOwner = {
  token: "dead",
  pid: 2_147_483_647,
  processStart: "dead",
};

const liveOwner: DurableLockOwner = {
  token: "live",
  pid: process.pid,
  processStart: getProcessStart(process.pid),
};

test("a crashed recoverer marker is completed from the exact dead inode", () => {
  const f = fixture();
  try {
    const deadPath = f.install(deadOwner, f.lock);
    linkSync(deadPath, f.marker);
    const release = acquireDurableFileLock(f.path, { waitMs: 50 });
    expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(deadPath)).toBe(false);
    release();
    expect(existsSync(f.lock)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dead recovery marker never removes an interleaved live replacement", () => {
  const f = fixture();
  try {
    const deadPath = f.install(deadOwner, f.marker);
    const livePath = f.install(liveOwner, f.lock);
    expect(() => acquireDurableFileLock(f.path, { waitMs: 10 })).toThrow();
    expect(readFileSync(f.lock, "utf8")).toBe(readFileSync(livePath, "utf8"));
    expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(deadPath)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a corrupt recovery marker fails closed", () => {
  const f = fixture();
  try {
    writeFileSync(f.marker, "not-json", { mode: 0o600 });
    expect(() => acquireDurableFileLock(f.path, { waitMs: 10 })).toThrow();
    expect(readFileSync(f.marker, "utf8")).toBe("not-json");
    expect(existsSync(f.lock)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("PID reuse is detected by process-start identity", () => {
  const f = fixture();
  try {
    const reused: DurableLockOwner = {
      token: "reused",
      pid: process.pid,
      processStart: `${getProcessStart(process.pid)}-previous`,
    };
    const reusedPath = f.install(reused, f.lock);
    const release = acquireDurableFileLock(f.path, { waitMs: 50 });
    expect(existsSync(reusedPath)).toBe(false);
    release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a paused live owner is never evicted and failed contenders clean candidates", () => {
  const f = fixture();
  try {
    f.install(liveOwner, f.lock);
    expect(() => acquireDurableFileLock(f.path, { waitMs: 10 })).toThrow();
    expect(existsSync(f.lock)).toBe(true);
    expect(readdirSync(f.owners)).toEqual([
      `${liveOwner.pid}-${liveOwner.token}.json`,
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a stale M0 recoverer never unlinks an interleaved live M1 marker", () => {
  const f = fixture();
  try {
    const deadPath = f.install(deadOwner, f.marker);
    let interleaved = false;
    expect(() =>
      acquireDurableFileLock(f.path, {
        waitMs: 10,
        beforeExactUnlink: (target) => {
          if (target !== f.marker || interleaved) return;
          interleaved = true;
          unlinkSync(f.marker);
          if (existsSync(deadPath)) unlinkSync(deadPath);
          const livePath = f.install(liveOwner, f.lock);
          linkSync(livePath, f.marker);
        },
      }),
    ).toThrow("Timed out acquiring");
    expect(readFileSync(f.marker, "utf8")).toBe(JSON.stringify(liveOwner));
    expect(readFileSync(f.lock, "utf8")).toBe(JSON.stringify(liveOwner));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a failed release marker race remains retryable", () => {
  const f = fixture();
  try {
    let interleaved = false;
    const release = acquireDurableFileLock(f.path, {
      waitMs: 50,
      beforeExactUnlink: (target) => {
        if (target !== f.marker || interleaved) return;
        interleaved = true;
        unlinkSync(f.marker);
        const livePath = f.install(liveOwner, f.lock);
        linkSync(livePath, f.marker);
      },
    });
    expect(release).toThrow("changed recovery marker");
    expect(readFileSync(f.marker, "utf8")).toBe(JSON.stringify(liveOwner));

    const livePath = join(f.owners, `${liveOwner.pid}-${liveOwner.token}.json`);
    unlinkSync(f.marker);
    unlinkSync(f.lock);
    unlinkSync(livePath);
    expect(release).not.toThrow();
    expect(existsSync(f.owners)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("process creation identity uses safe macOS and Windows argv", () => {
  const calls: Array<[string, string[]]> = [];
  const run = (executable: string, args: string[]) => {
    calls.push([executable, args]);
    return executable === "powershell"
      ? "1337\n"
      : "Mon Jan  1 00:00:00 2024\n";
  };
  expect(getProcessStart(42, "darwin", run)).toBe("Mon Jan  1 00:00:00 2024");
  expect(getProcessStart(42, "win32", run)).toBe("1337");
  expect(calls[0]).toEqual(["ps", ["-o", "lstart=", "-p", "42"]]);
  expect(calls[1]?.[0]).toBe("powershell");
  expect(calls[1]?.[1]).toContain("-NonInteractive");
});

test("unknown process identity fails closed while a mismatch detects reuse", () => {
  expect(
    durableLockOwnerIsAlive(
      { ...liveOwner, processStart: "recorded" },
      () => null,
    ),
  ).toBe(true);
  expect(
    durableLockOwnerIsAlive(
      { ...liveOwner, processStart: "recorded" },
      () => "replacement",
    ),
  ).toBe(false);
});

test("Windows skips unsupported directory fsync", () => {
  expect(() => fsyncDirectory("Z:\\definitely-missing", "win32")).not.toThrow();
});

test("released locks remove empty per-record owner directories", () => {
  const f = fixture();
  try {
    rmSync(f.owners, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      acquireDurableFileLock(f.path, { waitMs: 50 })();
      expect(existsSync(f.owners)).toBe(false);
    }
    expect(
      readdirSync(f.root).filter((name) => name.endsWith(".lock-owners")),
    ).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
