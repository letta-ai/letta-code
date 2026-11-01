import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exclusivePublishOps,
  isHardLinkUnsupportedError,
  publishExclusive,
  publishExclusiveSync,
} from "@/utils/exclusive-publish";
import { tryAcquireFileLock } from "@/utils/file-lock";

const originalOps = { ...exclusivePublishOps };

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: link`), { code });
}

/** Model a Windows volume without hard links: link fails with EISDIR. */
function simulateNoHardLinks(): { linkCalls: () => number } {
  let calls = 0;
  exclusivePublishOps.platform = () => "win32";
  exclusivePublishOps.link = async () => {
    calls++;
    throw errno("EISDIR");
  };
  exclusivePublishOps.linkSync = () => {
    calls++;
    throw errno("EISDIR");
  };
  return { linkCalls: () => calls };
}

describe("exclusive publish", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "letta-exclusive-publish-"));
  });

  afterEach(async () => {
    Object.assign(exclusivePublishOps, originalOps);
    await rm(dir, { recursive: true, force: true });
  });

  test("classifies only link-unsupported errors", () => {
    expect(isHardLinkUnsupportedError(errno("EISDIR"), "win32")).toBe(true);
    expect(isHardLinkUnsupportedError(errno("EISDIR"), "linux")).toBe(false);
    expect(isHardLinkUnsupportedError(errno("ENOTSUP"), "linux")).toBe(true);
    expect(isHardLinkUnsupportedError(errno("ENOSYS"), "darwin")).toBe(true);
    expect(isHardLinkUnsupportedError(errno("EXDEV"), "win32")).toBe(true);
    expect(isHardLinkUnsupportedError(errno("EPERM"), "linux")).toBe(true);
    expect(isHardLinkUnsupportedError(errno("EPERM"), "win32")).toBe(false);
    expect(isHardLinkUnsupportedError(errno("EEXIST"), "win32")).toBe(false);
    expect(isHardLinkUnsupportedError(errno("ENOENT"), "win32")).toBe(false);
    expect(isHardLinkUnsupportedError(errno("EACCES"), "linux")).toBe(false);
  });

  test("uses a hard link where supported", async () => {
    const source = join(dir, "source");
    await writeFile(source, "owner");
    expect(await publishExclusive(source, join(dir, "target"))).toBe("link");
  });

  test("falls back to a no-replace copy when hard links are unsupported", async () => {
    const { linkCalls } = simulateNoHardLinks();
    const source = join(dir, "source");
    const target = join(dir, "target");
    await writeFile(source, "first");
    expect(await publishExclusive(source, target)).toBe("copy");
    expect(readFileSync(target, "utf-8")).toBe("first");

    await writeFile(source, "second");
    await expect(publishExclusive(source, target)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(() => publishExclusiveSync(source, target)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(target, "utf-8")).toBe("first");
    expect(() =>
      publishExclusiveSync(join(dir, "missing"), join(dir, "other")),
    ).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(linkCalls()).toBe(4);
  });

  test("other link errors are not masked by the fallback", async () => {
    exclusivePublishOps.link = async () => {
      throw errno("EACCES");
    };
    const source = join(dir, "source");
    await writeFile(source, "owner");
    await expect(
      publishExclusive(source, join(dir, "target")),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(existsSync(join(dir, "target"))).toBe(false);
  });

  test("file lock works without hard links", async () => {
    simulateNoHardLinks();
    const lockPath = join(dir, "a.lock");

    const release = await tryAcquireFileLock(lockPath, { timeoutMs: 0 });
    expect(release).not.toBeNull();
    // A second contender is blocked while the first holds the lock.
    expect(await tryAcquireFileLock(lockPath, { timeoutMs: 0 })).toBeNull();
    await release?.();
    expect(existsSync(lockPath)).toBe(false);

    // A stale lock is still taken over.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 60_000 }),
    );
    const takeover = await tryAcquireFileLock(lockPath, {
      staleMs: 1_000,
      retryMs: 5,
      timeoutMs: 1_000,
    });
    expect(takeover).not.toBeNull();
    await takeover?.();
  });

  test("file lock does not reap a freshly half-written record", async () => {
    simulateNoHardLinks();
    const lockPath = join(dir, "a.lock");
    await writeFile(lockPath, '{"pid":12');

    expect(await tryAcquireFileLock(lockPath, { timeoutMs: 0 })).toBeNull();
    expect(readFileSync(lockPath, "utf-8")).toBe('{"pid":12');

    // Once old, the unparsable record is an abandoned acquisition.
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const release = await tryAcquireFileLock(lockPath, {
      retryMs: 5,
      timeoutMs: 1_000,
    });
    expect(release).not.toBeNull();
    await release?.();
  });
});
