/**
 * No-replace publication of a fully written private file under a shared name.
 *
 * Lock files are published with a hard link: the target either appears with
 * complete contents or not at all, and an existing target is never replaced.
 * Some volumes cannot create hard links at all (FAT/exFAT, some network,
 * VM-shared, or cloud-synced folders). There the link fails with an
 * "unsupported" error (Windows reports ERROR_INVALID_FUNCTION, which Node
 * surfaces as EISDIR), and we fall back to an exclusive-create copy.
 *
 * The copy keeps the no-replace guarantee (EEXIST when the target exists) but
 * not atomic visibility: a reader can briefly observe an empty or partially
 * written target, and the target does not share the source's inode. Readers of
 * published files must therefore treat unparsable contents as "being written"
 * for a short grace period rather than as abandoned.
 */

import { constants, copyFileSync, linkSync } from "node:fs";
import { copyFile, link } from "node:fs/promises";

export type PublishMethod = "link" | "copy";

/** Filesystem operations, replaceable by tests to simulate link failures. */
export const exclusivePublishOps = {
  link: (source: string, target: string): Promise<void> => link(source, target),
  linkSync: (source: string, target: string): void => linkSync(source, target),
  platform: (): NodeJS.Platform => process.platform,
};

/**
 * Grace for readers that see an unparsable published file. A copy of a lock
 * record (a few hundred bytes) completes in well under a millisecond unless
 * the writer is paused, so this only delays reaping a truly abandoned file.
 */
export const PARTIAL_PUBLISH_GRACE_MS = 2_000;

/** True when `link` failed because the volume cannot create hard links. */
export function isHardLinkUnsupportedError(
  error: unknown,
  platform: NodeJS.Platform = exclusivePublishOps.platform(),
): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOTSUP":
    case "EOPNOTSUPP":
    case "ENOSYS":
    case "EXDEV":
      return true;
    case "EISDIR":
      // CreateHardLink -> ERROR_INVALID_FUNCTION -> EISDIR on Windows. The
      // source is always a regular file we just wrote, so this cannot mean
      // that the source is a directory.
      return platform === "win32";
    case "EPERM":
      // POSIX link(2): "the filesystem does not support hard links" (vfat).
      // On Windows EPERM is an access/pending-delete failure; keep it as is.
      return platform !== "win32";
    default:
      return false;
  }
}

/**
 * Publish `source` at `target` without replacing an existing target. Throws
 * EEXIST when the target exists and ENOENT when the source is gone, exactly
 * like `link`. Returns which primitive succeeded.
 */
export async function publishExclusive(
  source: string,
  target: string,
): Promise<PublishMethod> {
  try {
    await exclusivePublishOps.link(source, target);
    return "link";
  } catch (error) {
    if (!isHardLinkUnsupportedError(error)) throw error;
  }
  await copyFile(source, target, constants.COPYFILE_EXCL);
  return "copy";
}

/** Synchronous variant of {@link publishExclusive}. */
export function publishExclusiveSync(
  source: string,
  target: string,
): PublishMethod {
  try {
    exclusivePublishOps.linkSync(source, target);
    return "link";
  } catch (error) {
    if (!isHardLinkUnsupportedError(error)) throw error;
  }
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  return "copy";
}

/**
 * True when `mtimeMs` is recent enough that an unparsable published file may
 * still be in the middle of an exclusive-create copy.
 */
export function isWithinPartialPublishGrace(
  mtimeMs: number,
  now: number = Date.now(),
): boolean {
  return now - mtimeMs <= PARTIAL_PUBLISH_GRACE_MS;
}
