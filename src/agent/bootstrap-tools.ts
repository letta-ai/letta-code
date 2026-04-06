/**
 * Bootstrap base tools once per process lifetime.
 *
 * Calls POST /v1/tools/add-base-tools on startup to ensure all base tools
 * exist. This backfills orgs that were created with an incomplete tool set
 * (e.g., missing web_search/fetch_webpage due to a core server deployment
 * that failed to load the builtin module).
 */

import { getServerUrl } from "./client";
import { addBaseToolsToServer } from "./create";

/**
 * In-memory flag — ensures we only call add-base-tools once per process
 * lifetime. We don't persist markers to disk because the identifiers
 * available at startup (proxy port, session token) are ephemeral and
 * change on every app launch. The POST is cheap (upsert, no-op if tools
 * exist) so running once per launch is acceptable.
 */
let bootstrapped = false;

/**
 * Call add-base-tools once per process to ensure all base tools exist.
 * Fire-and-forget — failures are logged but don't block startup.
 */
export async function bootstrapBaseToolsIfNeeded(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  try {
    await addBaseToolsToServer();
  } catch (err) {
    // Non-fatal — the retry in createAgentWithBaseToolsRecovery is the safety net
    console.warn(
      `[bootstrap] Failed to bootstrap base tools: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
