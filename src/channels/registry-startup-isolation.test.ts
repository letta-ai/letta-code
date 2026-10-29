import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import { __testClearUserChannelPluginCache } from "@/channels/plugin-registry";
import {
  ChannelInitializationError,
  formatChannelStartupFailures,
  getChannelRegistry,
  initializeChannels,
} from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
} from "@/channels/routing";
import type { ChannelAccount } from "@/channels/types";

let channelsRoot: string;

function writeFlakyChannel(): void {
  const channelDir = join(channelsRoot, "flaky");
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(
    join(channelDir, "channel.json"),
    `${JSON.stringify({ id: "flaky", displayName: "Flaky", entry: "./plugin.mjs" })}\n`,
  );
  writeFileSync(
    join(channelDir, "plugin.mjs"),
    `export const channelPlugin = {
      metadata: { id: "flaky", displayName: "Flaky" },
      createAdapter(account) {
        let running = false;
        return {
          id: "flaky:" + account.accountId,
          channelId: "flaky",
          accountId: account.accountId,
          name: "Flaky",
          start: async () => {
            if (account.accountId.startsWith("slow")) {
              throw new Error("Flaky bot init timed out after 15000ms");
            }
            running = true;
          },
          stop: async () => { running = false; },
          isRunning: () => running,
          sendMessage: async () => ({ messageId: "flaky-1" }),
          sendDirectReply: async () => {}
        };
      }
    };\n`,
  );
}

function flakyAccount(accountId: string): ChannelAccount {
  return {
    channel: "flaky",
    accountId,
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    config: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("initializeChannels startup isolation", () => {
  beforeEach(() => {
    channelsRoot = mkdtempSync(join(tmpdir(), "letta-channel-isolation-"));
    __testOverrideChannelsRoot(channelsRoot);
    __testClearUserChannelPluginCache();
    writeFlakyChannel();
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideSaveChannelAccounts(() => {});
  });

  afterEach(async () => {
    await getChannelRegistry()?.stopAll();
    clearAllRoutes();
    clearPairingStores();
    clearChannelAccountStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideChannelsRoot(null);
    __testClearUserChannelPluginCache();
    rmSync(channelsRoot, { recursive: true, force: true });
  });

  test("one failed account does not stop the healthy accounts", async () => {
    __testOverrideLoadChannelAccounts((channelId) =>
      channelId === "flaky"
        ? [
            flakyAccount("bot-a"),
            flakyAccount("slow-bot"),
            flakyAccount("bot-b"),
          ]
        : [],
    );
    const logs: string[] = [];

    const registry = await initializeChannels(["flaky"], {
      failOnStartupError: true,
      logger: (message) => logs.push(message),
    });

    expect(registry.getAdapter("flaky", "bot-a")?.isRunning()).toBe(true);
    expect(registry.getAdapter("flaky", "bot-b")?.isRunning()).toBe(true);
    expect(registry.getAdapter("flaky", "slow-bot")?.isRunning()).toBe(false);
    const report = logs.find((line) =>
      line.includes("Some requested channel listeners failed to start"),
    );
    expect(report).toContain(
      "- flaky/slow-bot: Flaky bot init timed out after 15000ms",
    );
    expect(report).not.toContain("bot-a");
    expect(report).not.toContain("--install-channel-runtimes");
  });

  test("startup still fails when no requested account starts", async () => {
    __testOverrideLoadChannelAccounts((channelId) =>
      channelId === "flaky" ? [flakyAccount("slow-bot")] : [],
    );

    await expect(
      initializeChannels(["flaky"], { failOnStartupError: true }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);
    expect(getChannelRegistry()).toBeNull();
  });
});

describe("formatChannelStartupFailures", () => {
  test("suggests installing runtimes only for missing-runtime failures", () => {
    const timeoutOnly = formatChannelStartupFailures([
      {
        channelId: "telegram",
        accountId: "bot-1",
        error: "Telegram bot init timed out after 15000ms",
      },
    ]);
    expect(timeoutOnly).not.toContain("--install-channel-runtimes");
    expect(timeoutOnly).not.toContain("letta channels install");

    const mixed = formatChannelStartupFailures([
      {
        channelId: "telegram",
        accountId: "bot-1",
        error: "Telegram bot init timed out after 15000ms",
      },
      {
        channelId: "discord",
        accountId: "bot-2",
        error: "Discord support is not installed.",
        missingRuntime: true,
      },
    ]);
    expect(mixed).toContain(
      "letta server --channels discord --install-channel-runtimes",
    );
    expect(mixed).toContain("  letta channels install discord");
    expect(mixed).not.toContain("letta channels install telegram");
  });
});
