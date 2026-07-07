import {
  type ChannelReloadSummary,
  getChannelRegistry,
} from "@/channels/registry";
import { refreshCustomCommands } from "@/cli/commands/custom";
import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";
import { markSecretsReminderRefreshPending } from "./commands/secrets";
import { reloadListenerModAdapter } from "./mod-adapter";
import {
  ensureSecretsHydratedForAgent,
  invalidateSecretsCacheForAgent,
} from "./secrets-sync";
import type { ListenerRuntime } from "./types";

function formatChannelReloadFailures(
  failures: ChannelReloadSummary["failures"],
): string {
  return failures
    .map((failure) => {
      const label = failure.accountId
        ? `${failure.channelId}/${failure.accountId}`
        : failure.channelId;
      return `${label}: ${failure.error}`;
    })
    .join("; ");
}

export async function reloadListenerRuntimeSurfaces(
  listener: ListenerRuntime,
  options: {
    agentId?: string | null;
    logger?: (message: string) => void;
  } = {},
): Promise<string> {
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

  await reloadListenerModAdapter(listener);

  const agentId = options.agentId?.trim();
  if (agentId) {
    invalidateSecretsCacheForAgent(listener, agentId);
    markSecretsReminderRefreshPending(listener, agentId);
    await ensureSecretsHydratedForAgent(listener, agentId);
  }

  const registry = getChannelRegistry();
  const channelReloadSummary = registry
    ? await registry.reloadActiveChannels({ logger: options.logger })
    : null;

  const base = agentId
    ? "Reloaded settings, local mods, and agent secrets"
    : "Reloaded settings and local mods";

  if (!channelReloadSummary) {
    return `${base}. No running channel registry was found.`;
  }

  const channelParts = [
    `restarted ${channelReloadSummary.restarted}`,
    `stopped ${channelReloadSummary.stopped}`,
  ];
  if (channelReloadSummary.failures.length > 0) {
    channelParts.push(
      `failed ${channelReloadSummary.failures.length} (${formatChannelReloadFailures(
        channelReloadSummary.failures,
      )})`,
    );
  }

  return `${base}. Channel adapters: ${channelParts.join(", ")}.`;
}
