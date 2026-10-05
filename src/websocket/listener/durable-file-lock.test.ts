import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDurableFileLock,
  type DurableLockOwner,
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
