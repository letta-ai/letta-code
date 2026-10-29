/** Disk persistence and backwards-compatible filename migration for routes. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  getChannelDir,
  getChannelRoutingPath,
  getLegacyChannelRoutingPath,
} from "./config";
import type { ChannelRoute } from "./types";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function readRoutingFile(path: string): ChannelRoute[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf-8")) as {
    routes?: ChannelRoute[];
  } | null;
  if (!parsed || !Array.isArray(parsed.routes)) {
    throw new Error(`Invalid routing file: ${path}`);
  }
  return parsed.routes.filter(
    (route) => route?.chatId && route.agentId && route.conversationId,
  );
}

/** Prefer the current file; migration is never a prerequisite for reading. */
export function readChannelRoutesFromDisk(channelId: string): ChannelRoute[] {
  const path = getChannelRoutingPath(channelId);
  try {
    return readRoutingFile(path);
  } catch (error) {
    // Only absence permits fallback. A broken/unreadable current file must not
    // resurrect stale routes from a legacy file left behind during cleanup.
    if (!isMissing(error)) return [];
  }

  const legacyPath = getLegacyChannelRoutingPath(channelId);
  let routes: ChannelRoute[];
  try {
    routes = readRoutingFile(legacyPath);
  } catch {
    // A concurrent migration may have removed the old name since our first read.
    try {
      return readRoutingFile(path);
    } catch {
      return [];
    }
  }

  try {
    // Both names are in the same directory. A hard link publishes the complete
    // existing file atomically and fails if another process created the target.
    // Unlike rename, it cannot replace a newer routing.json. On filesystems
    // without hard links, keep reading the legacy file until a normal save.
    fs.linkSync(legacyPath, path);
  } catch {
    try {
      // Another process may have migrated or saved while we read the legacy file.
      return readRoutingFile(path);
    } catch (error) {
      return isMissing(error) ? routes : [];
    }
  }

  try {
    fs.unlinkSync(legacyPath);
  } catch {
    // Publication succeeded. Interrupted/denied cleanup can leave both names;
    // routing.json remains authoritative on every subsequent read.
  }
  return routes;
}

/** Publish complete snapshots; a failed write leaves the previous file intact. */
export function writeChannelRoutesToDisk(
  channelId: string,
  routes: ChannelRoute[],
): void {
  fs.mkdirSync(getChannelDir(channelId), { recursive: true });
  const path = getChannelRoutingPath(channelId);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ routes }, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporaryPath, path);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Usually already renamed. Cleanup must not mask a failed write/rename.
    }
  }
}
