/**
 * Bootstrap base tools on first connection to a server.
 *
 * Calls POST /v1/tools/add-base-tools once per server URL, then writes a
 * marker file so subsequent runs skip the call. This ensures that orgs
 * created with an incomplete tool set (e.g., missing web_search/fetch_webpage)
 * get backfilled the first time letta-code connects.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getServerUrl } from "./client";
import { addBaseToolsToServer } from "./create";

const MARKERS_DIR = join(homedir(), ".letta", ".tool-bootstrap-markers");

function getMarkerPath(serverUrl: string): string {
  const hash = createHash("sha256").update(serverUrl).digest("hex").slice(0, 16);
  return join(MARKERS_DIR, hash);
}

/**
 * If this is the first time connecting to the current server, call
 * add-base-tools to ensure all tools exist. Fire-and-forget — failures
 * are logged but don't block startup.
 */
export async function bootstrapBaseToolsIfNeeded(): Promise<void> {
  const serverUrl = getServerUrl();
  const markerPath = getMarkerPath(serverUrl);

  if (existsSync(markerPath)) {
    return;
  }

  try {
    const success = await addBaseToolsToServer();
    if (success) {
      // Write marker so we don't call again
      mkdirSync(MARKERS_DIR, { recursive: true });
      writeFileSync(markerPath, new Date().toISOString(), "utf-8");
    }
  } catch (err) {
    // Non-fatal — the retry in createAgentWithBaseToolsRecovery is the safety net
    console.warn(
      `[bootstrap] Failed to bootstrap base tools: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
