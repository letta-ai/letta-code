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
import { settingsManager } from "../settings-manager";

const MARKERS_DIR = join(homedir(), ".letta", ".tool-bootstrap-markers");

function getMarkerPath(serverUrl: string, apiKey: string): string {
  const hash = createHash("sha256")
    .update(`${serverUrl}:${apiKey}`)
    .digest("hex")
    .slice(0, 16);
  return join(MARKERS_DIR, hash);
}

/**
 * If this is the first time this user is connecting to the current server,
 * call add-base-tools to ensure all tools exist. Keyed by server URL + API
 * key so different users/orgs on the same machine each get bootstrapped.
 * Fire-and-forget — failures are logged but don't block startup.
 */
export async function bootstrapBaseToolsIfNeeded(): Promise<void> {
  const serverUrl = getServerUrl();
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!apiKey) return;

  const markerPath = getMarkerPath(serverUrl, apiKey);

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
