/**
 * Bootstrap base tools once per machine.
 *
 * Calls POST /v1/tools/add-base-tools on first startup, then writes a
 * marker file to ~/.letta/ so subsequent launches skip the call. This
 * backfills orgs created with an incomplete tool set (e.g., missing
 * web_search/fetch_webpage due to a core server deployment that failed
 * to load the builtin module).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog, debugWarn } from "../utils/debug";
import { addBaseToolsToServer } from "./create";

const MARKER_PATH = join(homedir(), ".letta", ".bootstrapped");

/**
 * Call add-base-tools once, then write a marker so future launches skip it.
 * Fire-and-forget — failures are logged but don't block startup.
 */
export async function bootstrapBaseToolsIfNeeded(): Promise<void> {
  if (existsSync(MARKER_PATH)) return;

  debugLog("bootstrap", "No marker found, bootstrapping base tools...");

  try {
    const success = await addBaseToolsToServer();
    if (success) {
      mkdirSync(join(homedir(), ".letta"), { recursive: true });
      writeFileSync(MARKER_PATH, new Date().toISOString(), "utf-8");
    }
  } catch (err) {
    // Non-fatal — the retry in createAgentWithBaseToolsRecovery is the safety net
    debugWarn(
      "bootstrap",
      `Failed to bootstrap base tools: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
