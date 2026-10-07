import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";

export function fsyncInterruptedTurnDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // Windows cannot open directories. The temp file itself is still flushed by
  // writeFileSync, while POSIX additionally commits directory entry changes.
  if (platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function defaultInterruptedTurnDirectory(): string {
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL ?? "uninitialized";
  }
  return join(
    homedir(),
    ".letta",
    "listener-state",
    createHash("sha256").update(serverUrl).digest("hex").slice(0, 24),
  );
}
