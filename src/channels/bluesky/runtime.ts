/**
 * Runtime-dep loader stub for Bluesky.
 *
 * V1 is a receive-only notifications poller that speaks XRPC over the
 * built-in `fetch`, so no external runtime modules need to be installed.
 * We keep this file so the channel still has a conventional entry point
 * for future deps (e.g. `@atproto/api`, `undici`, Jetstream WebSockets)
 * without having to shuffle imports across the codebase when they land.
 */

import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
} from "../runtimeDeps";

export function isBlueskyRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("bluesky");
}

export async function installBlueskyRuntime(): Promise<void> {
  await installChannelRuntime("bluesky");
}

export async function ensureBlueskyRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("bluesky");
}
