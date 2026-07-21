import { clearDynamicMessageChannelToolCache } from "@/channels/message-tool";
import type { ChannelRegistry } from "@/channels/registry";
import type { ChannelReloadHandler } from "@/channels/registry-handlers";
import { refreshCustomCommands } from "@/cli/commands/custom";
import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";
import { beginChannelReloadBarrier } from "./channel-reload-barrier";
import { getActiveChannelTurnDrainPromise } from "./channel-turn-session";
import { markSecretsReminderRefreshPending } from "./commands/secrets";
import { reloadListenerModAdapter } from "./mod-adapter";
import {
  ensureSecretsHydratedForAgent,
  invalidateSecretsCacheForAgent,
} from "./secrets-sync";
import type {
  ConversationRuntime,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

export const CHANNEL_RELOAD_DRAIN_TIMEOUT_MS = 30_000;
export const CHANNEL_RELOAD_ACK_TEXT =
  "Reload queued. Channel messages will be buffered while active turns finish.";
export const CHANNEL_RELOAD_RUNNING_TEXT = "Reload running.";

export function clearReloadedChannelToolCache(): void {
  clearDynamicMessageChannelToolCache();
}

export async function reloadListenerRuntimeSurfaces(
  conversationRuntime: ConversationRuntime,
): Promise<string> {
  const { listener } = conversationRuntime;
  settingsManager.clearCaches();
  await settingsManager.loadProjectSettings();
  await settingsManager.loadLocalProjectSettings();

  try {
    refreshCustomCommands();
  } catch (error) {
    debugLog(
      "commands",
      "refreshCustomCommands failed during /reload:",
      error instanceof Error ? error.message : String(error),
    );
  }

  await reloadListenerModAdapter(listener, conversationRuntime.agentId);
  if (conversationRuntime.agentId) {
    invalidateSecretsCacheForAgent(listener, conversationRuntime.agentId);
    markSecretsReminderRefreshPending(listener, conversationRuntime.agentId);
    await ensureSecretsHydratedForAgent(listener, conversationRuntime.agentId);
  }
  return "Reloaded settings, local mods, and agent secrets";
}

function collectChannelTurnDrains(listener: ListenerRuntime): Promise<void>[] {
  const drains: Promise<void>[] = [];
  for (const runtime of listener.conversationRuntimes.values()) {
    const activeDrain = getActiveChannelTurnDrainPromise(runtime);
    if (activeDrain) drains.push(activeDrain);
  }
  return drains;
}

export async function waitForChannelTurnDrains(
  listener: ListenerRuntime,
  timeoutMs = CHANNEL_RELOAD_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const drains = collectChannelTurnDrains(listener);
    if (drains.length === 0) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        "Timed out waiting for active channel turns to finish before reload",
      );
    }

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        Promise.all(drains.map((drain) => drain.catch(() => {}))),
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Timed out waiting for active channel turns to finish before reload",
                ),
              ),
            remainingMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function formatChannelReloadSummary(
  settingsOutput: string,
  summary: {
    restarted: string[];
    stopped: string[];
    bufferedDeliveries: number;
  },
): string {
  const restarted = summary.restarted.join(", ") || "none";
  const stopped = summary.stopped.join(", ") || "none";
  return `${settingsOutput}. Reloaded channel accounts, routes, and adapters. Restarted: ${restarted}. Stopped: ${stopped}. Buffered inbound messages: ${summary.bufferedDeliveries}.`;
}

export function createChannelReloadHandler(params: {
  registry: ChannelRegistry;
  listener: ListenerRuntime;
  getOrCreateRuntime: (
    agentId: string,
    conversationId: string,
  ) => ConversationRuntime;
  reloadRuntimeSurfaces: (runtime: ConversationRuntime) => Promise<string>;
  afterRuntimeReload: (
    runtime: ConversationRuntime,
    scope: { agent_id: string; conversation_id: string },
  ) => void;
  logger?: StartListenerOptions["onLog"];
}): ChannelReloadHandler {
  return async ({
    channelId,
    accountId,
    chatId,
    messageId,
    threadId,
    runtime,
  }) => {
    const scopedRuntime = params.getOrCreateRuntime(
      runtime.agent_id,
      runtime.conversation_id,
    );
    return {
      handled: true,
      text: CHANNEL_RELOAD_ACK_TEXT,
      afterReply: async () => {
        const releaseReloadBarrier = beginChannelReloadBarrier(params.listener);
        const sendResult = async (text: string) => {
          const adapter = params.registry.getAdapter(channelId, accountId);
          if (!adapter?.isRunning()) return;
          await adapter.sendDirectReply(chatId, text, {
            replyToMessageId: messageId,
            threadId,
          });
        };

        try {
          let settingsOutput =
            "Reloaded settings, local mods, and agent secrets";
          const summary = await params.registry.reloadConfiguredChannels({
            forceReloadPlugins: true,
            logger: params.logger,
            timeoutMs: CHANNEL_RELOAD_DRAIN_TIMEOUT_MS,
            beforeRestart: async () => {
              await waitForChannelTurnDrains(params.listener);
              await sendResult(CHANNEL_RELOAD_RUNNING_TEXT);
              settingsOutput =
                await params.reloadRuntimeSurfaces(scopedRuntime);
              params.afterRuntimeReload(scopedRuntime, runtime);
            },
            afterRestart: clearReloadedChannelToolCache,
          });
          await sendResult(formatChannelReloadSummary(settingsOutput, summary));
        } catch (error) {
          await sendResult(
            `Failed to reload listener settings and channels: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          releaseReloadBarrier();
        }
      },
    };
  };
}
