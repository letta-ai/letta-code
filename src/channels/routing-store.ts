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

export function readChannelRoutesFromDisk(channelId: string): ChannelRoute[] {
  const path = getChannelRoutingPath(channelId);
  try {
    return readRoutingFile(path);
  } catch (error) {
    if (!isMissing(error)) return [];
  }

  const legacyPath = getLegacyChannelRoutingPath(channelId);
  let routes: ChannelRoute[];
  try {
    routes = readRoutingFile(legacyPath);
  } catch {
    try {
      return readRoutingFile(path);
    } catch {
      return [];
    }
  }

  try {
    fs.linkSync(legacyPath, path);
  } catch {
    try {
      return readRoutingFile(path);
    } catch (error) {
      return isMissing(error) ? routes : [];
    }
  }

  try {
    fs.unlinkSync(legacyPath);
  } catch {}
  return routes;
}

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
    } catch {}
  }
}
