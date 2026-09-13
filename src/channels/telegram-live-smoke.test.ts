import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { __testOverrideChannelRuntimeDeps } from "@/channels/runtime-deps";
import { validateTelegramToken } from "@/channels/telegram/account-display";
import { createTelegramAdapter } from "@/channels/telegram/adapter";
import type { TelegramChannelAccount } from "@/channels/types";

const runLiveSmoke = process.env.LETTA_RUN_LIVE_TELEGRAM_SMOKE === "1";
const liveTest = runLiveSmoke ? test : test.skip;

let smokeRoot: string | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function setupRuntimeRootFromRepoNodeModules(): void {
  smokeRoot = mkdtempSync(join(tmpdir(), "letta-telegram-live-smoke-"));
  __testOverrideChannelsRoot(join(smokeRoot, "channels"));

  const runtimeRoot = join(smokeRoot, "runtime-root");
  const telegramRuntimeDir = join(runtimeRoot, "telegram", "runtime");
  mkdirSync(telegramRuntimeDir, { recursive: true });
  writeFileSync(
    join(telegramRuntimeDir, "package.json"),
    `${JSON.stringify({ name: "letta-telegram-live-smoke", private: true })}\n`,
    "utf-8",
  );

  const repoNodeModules = join(process.cwd(), "node_modules");
  if (!existsSync(join(repoNodeModules, "grammy"))) {
    throw new Error(
      "Telegram live smoke requires dependencies installed with node_modules/grammy present.",
    );
  }
  symlinkSync(
    repoNodeModules,
    join(runtimeRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  __testOverrideChannelRuntimeDeps({ runtimeRoot });
}

afterEach(() => {
  __testOverrideChannelRuntimeDeps(null);
  __testOverrideChannelsRoot(null);
  if (smokeRoot) {
    rmSync(smokeRoot, { recursive: true, force: true });
    smokeRoot = null;
  }
});

liveTest(
  "live Telegram bot validates token and sends a smoke message",
  async () => {
    setupRuntimeRootFromRepoNodeModules();

    const token = requireEnv("TELEGRAM_SMOKE_BOT_TOKEN");
    const chatId = requireEnv("TELEGRAM_SMOKE_CHAT_ID");
    const threadId = process.env.TELEGRAM_SMOKE_THREAD_ID?.trim() || undefined;

    const info = await validateTelegramToken(token);
    expect(info.username).toBeTruthy();

    const account: TelegramChannelAccount = {
      channel: "telegram",
      accountId: "telegram-live-smoke",
      displayName: info.username ? `@${info.username}` : "Telegram Live Smoke",
      enabled: true,
      token,
      dmPolicy: "pairing",
      allowedUsers: [],
      groupMode: "open",
      transcribeVoice: false,
      binding: {
        agentId: "agent-live-smoke",
        conversationId: "default",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const adapter = createTelegramAdapter(account);

    try {
      const sent = await adapter.sendMessage({
        channel: "telegram",
        accountId: account.accountId,
        chatId,
        threadId,
        text: `Letta Telegram live smoke ${process.env.GITHUB_RUN_ID ?? "local"} ${Date.now()}`,
      });

      expect(sent.messageId).toBeTruthy();
    } finally {
      await adapter.stop();
    }
  },
);
