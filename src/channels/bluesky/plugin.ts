import type { ChannelPlugin } from "../pluginTypes";
import type { BlueskyChannelAccount, ChannelAccount } from "../types";
import { createBlueskyAdapter } from "./adapter";
import { runBlueskySetup } from "./setup";

/**
 * Bluesky channel plugin.
 *
 * V1 is an inbound-only plugin: notifications are polled from the AppView
 * and delivered to the agent. The agent's normal text responses are sent
 * back as plain-text replies via `adapter.sendMessage`. Anything richer
 * (facets, images, quote posts, likes, follows, blocks, scheduled posts)
 * flows through `social-cli`, which owns the full Bluesky write surface.
 *
 * A follow-up PR will introduce `messageActions` with a proper
 * `reply`/`quote`/`like`/`repost`/`follow`/`block` vocabulary for the
 * shared MessageChannel tool — see `plans/2026-04-23-bluesky-channel-v1.md`.
 */
export const blueskyChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "bluesky",
    displayName: "Bluesky",
    runtimePackages: [],
    runtimeModules: [],
  },
  createAdapter(account: ChannelAccount) {
    return createBlueskyAdapter(account as BlueskyChannelAccount);
  },
  runSetup() {
    return runBlueskySetup();
  },
};
