import { constants, copyFileSync, linkSync } from "node:fs";
import { copyFile, link } from "node:fs/promises";

export type PublishMethod = "link" | "copy";
export const exclusivePublishOps = {
  link: (source: string, target: string): Promise<void> => link(source, target),
  linkSync: (source: string, target: string): void => linkSync(source, target),
  platform: (): NodeJS.Platform => process.platform,
};

export const PARTIAL_PUBLISH_GRACE_MS = 2_000;

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
      return platform === "win32";
    case "EPERM":
      return platform !== "win32";
    default:
      return false;
  }
}

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

export function isWithinPartialPublishGrace(
  mtimeMs: number,
  now: number = Date.now(),
): boolean {
  return now - mtimeMs <= PARTIAL_PUBLISH_GRACE_MS;
}
