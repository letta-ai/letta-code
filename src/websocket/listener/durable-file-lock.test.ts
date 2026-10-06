import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
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
  const ownerName = (owner: DurableLockOwner) =>
    `${owner.pid}-${owner.token}.json`;
  const populate = (directory: string, owner: DurableLockOwner) => {
    mkdirSync(directory, { mode: 0o700 });
    const ownerPath = join(directory, ownerName(owner));
    writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    return ownerPath;
  };
  const install = (owner: DurableLockOwner) => populate(lock, owner);
  const replaceEmpty = (replacement: string) => {
    try {
      // POSIX atomically replaces the now-empty M0 directory.
      renameSync(replacement, lock);
    } catch (error) {
      // Windows does not replace an existing directory. Model the only possible
      // ordering there: M0 is removed, then M1 is installed.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      rmdirSync(lock);
      renameSync(replacement, lock);
    }
  };
  return { root, path, lock, ownerName, populate, install, replaceEmpty };
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

test("a dead lock directory is recovered", () => {
  const f = fixture();
  try {
    f.install(deadOwner);
    const release = acquireDurableFileLock(f.path, { waitMs: 50 });
    const names = readdirSync(f.lock);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(f.ownerName(deadOwner));
    release();
    expect(existsSync(f.lock)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("stale M0 cleanup cannot remove atomically installed live M1", () => {
  const f = fixture();
  try {
    f.install(deadOwner);
    const replacement = `${f.lock}.replacement`;
    f.populate(replacement, liveOwner);
    let interleaved = false;
    expect(() =>
      acquireDurableFileLock(f.path, {
        waitMs: 10,
        afterOwnerUnlink: (target) => {
          if (target !== f.lock || interleaved) return;
          interleaved = true;
          f.replaceEmpty(replacement);
        },
      }),
    ).toThrow("Timed out acquiring");
    expect(readdirSync(f.lock)).toEqual([f.ownerName(liveOwner)]);
    expect(readFileSync(join(f.lock, f.ownerName(liveOwner)), "utf8")).toBe(
      JSON.stringify(liveOwner),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a release cannot rmdir an atomically installed replacement", () => {
  const f = fixture();
  try {
    const replacement = `${f.lock}.replacement`;
    f.populate(replacement, liveOwner);
    let interleaved = false;
    const release = acquireDurableFileLock(f.path, {
      waitMs: 50,
      afterOwnerUnlink: (target) => {
        if (target !== f.lock || interleaved) return;
        interleaved = true;
        f.replaceEmpty(replacement);
      },
    });
    release();
    expect(readdirSync(f.lock)).toEqual([f.ownerName(liveOwner)]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a paused live owner is never evicted and contender candidates are cleaned", () => {
  const f = fixture();
  try {
    f.install(liveOwner);
    expect(() => acquireDurableFileLock(f.path, { waitMs: 10 })).toThrow(
      "Timed out acquiring",
    );
    expect(readdirSync(f.lock)).toEqual([f.ownerName(liveOwner)]);
    expect(
      readdirSync(f.root).filter((name) => name.includes(".lock.candidate-")),
    ).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("candidate sweep removes only a provably dead owner", () => {
  const f = fixture();
  try {
    const deadCandidate = `${f.lock}.candidate-dead-orphan`;
    const liveCandidate = `${f.lock}.candidate-live-owner`;
    const malformedCandidate = `${f.lock}.candidate-malformed`;
    const emptyCandidate = `${f.lock}.candidate-empty`;
    f.populate(deadCandidate, deadOwner);
    f.populate(liveCandidate, liveOwner);
    mkdirSync(malformedCandidate);
    writeFileSync(join(malformedCandidate, "owner.json"), "not-json");
    mkdirSync(emptyCandidate);

    acquireDurableFileLock(f.path, { waitMs: 50 })();

    expect(existsSync(deadCandidate)).toBe(false);
    expect(readdirSync(liveCandidate)).toEqual([f.ownerName(liveOwner)]);
    expect(readFileSync(join(malformedCandidate, "owner.json"), "utf8")).toBe(
      "not-json",
    );
    expect(readdirSync(emptyCandidate)).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("candidate setup failure cleans its private directory", () => {
  const f = fixture();
  try {
    const owner = {
      ...deadOwner,
      token: "setup-failure",
      toJSON: () => {
        throw new Error("injected setup failure");
      },
    };
    expect(() => acquireDurableFileLock(f.path, { owner, waitMs: 10 })).toThrow(
      "injected setup failure",
    );
    expect(readdirSync(f.root)).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("corrupt and multiple-owner directories fail closed", () => {
  for (const contents of ["corrupt", "multiple"] as const) {
    const f = fixture();
    try {
      mkdirSync(f.lock);
      writeFileSync(join(f.lock, "unknown.json"), "not-json");
      if (contents === "multiple") {
        writeFileSync(join(f.lock, "another.json"), JSON.stringify(deadOwner));
      }
      expect(() => acquireDurableFileLock(f.path, { waitMs: 10 })).toThrow();
      expect(existsSync(f.lock)).toBe(true);
      expect(readdirSync(f.lock)).toHaveLength(contents === "multiple" ? 2 : 1);
      expect(
        readdirSync(f.root).filter((name) => name.includes(".lock.candidate-")),
      ).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
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
    f.install(reused);
    const release = acquireDurableFileLock(f.path, { waitMs: 50 });
    expect(readdirSync(f.lock)).not.toContain(f.ownerName(reused));
    release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("EPERM still checks PID reuse while unknown identity fails closed", () => {
  const inaccessible = () => {
    const error = new Error("inaccessible") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  };
  const recorded = { ...liveOwner, processStart: "recorded" };
  expect(
    durableLockOwnerIsAlive(recorded, () => "replacement", inaccessible),
  ).toBe(false);
  expect(durableLockOwnerIsAlive(recorded, () => null, inaccessible)).toBe(
    true,
  );
  expect(
    durableLockOwnerIsAlive(
      { ...recorded, processStart: null },
      () => "replacement",
      inaccessible,
    ),
  ).toBe(true);
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

test("Windows skips unsupported directory fsync", () => {
  expect(() => fsyncDirectory("Z:\\definitely-missing", "win32")).not.toThrow();
});

test("an empty recovery artifact is cleaned", () => {
  const f = fixture();
  try {
    mkdirSync(f.lock);
    const release = acquireDurableFileLock(f.path, { waitMs: 50 });
    expect(readdirSync(f.lock)).toHaveLength(1);
    release();
    expect(readdirSync(f.root)).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("release removes empty lock artifacts", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 20; index += 1) {
      acquireDurableFileLock(f.path, { waitMs: 50 })();
      expect(existsSync(f.lock)).toBe(false);
      expect(readdirSync(f.root)).toEqual([]);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
