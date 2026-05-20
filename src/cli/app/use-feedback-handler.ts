// src/cli/app/useFeedbackHandler.ts

import { type MutableRefObject, useCallback } from "react";
import type { SessionStats } from "@/agent/stats";
import { submitFeedbackMetadata } from "@/backend/api/metadata";
import { chunkLog } from "@/cli/helpers/chunk-log";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { resolvePlaceholders } from "@/cli/helpers/paste-registry";
import { getDeviceType, getLocalTime } from "@/cli/helpers/session-context";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { debugLogFile } from "@/utils/debug";
import { getVersion } from "@/version";
import type { CommandStarter, OverlayCommandConsumer } from "./types";

type FeedbackHandlerContext = {
  agentDescription: string | null;
  agentId: string;
  agentName: string | null;
  billingTier: string | null;
  closeOverlay: () => void;
  commandRunner: CommandStarter;
  consumeOverlayCommand: OverlayCommandConsumer;
  currentModelId: string | null;
  sessionStatsRef: MutableRefObject<SessionStats>;
  withCommandLock: (fn: () => Promise<void>) => Promise<void>;
};

export function useFeedbackHandler(ctx: FeedbackHandlerContext) {
  const {
    agentDescription,
    agentId,
    agentName,
    billingTier,
    closeOverlay,
    commandRunner,
    consumeOverlayCommand,
    currentModelId,
    sessionStatsRef,
    withCommandLock,
  } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionStatsRef is stable; .current is read dynamically when feedback is submitted.
  const handleFeedbackSubmit = useCallback(
    async (message: string) => {
      // Consume command handle BEFORE closing overlay; otherwise closeOverlay()
      // finishes it as "Feedback dialog dismissed" and we emit a duplicate entry.
      const overlayCommand = consumeOverlayCommand("feedback");
      closeOverlay();

      await withCommandLock(async () => {
        const cmd =
          overlayCommand ??
          commandRunner.start("/feedback", "Sending feedback...");

        try {
          const resolvedMessage = resolvePlaceholders(message);

          cmd.update({
            output: "Sending feedback...",
            phase: "running",
          });

          const settings = settingsManager.getSettings();
          const apiKey =
            process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

          // Only send anonymized, safe settings for debugging
          const {
            env: _env,
            refreshToken: _refreshToken,
            ...safeSettings
          } = settings;

          await submitFeedbackMetadata(
            apiKey,
            settingsManager.getOrCreateDeviceId(),
            {
              message: resolvedMessage,
              feature: "letta-code",
              agent_id: agentId,
              session_id: telemetry.getSessionId(),
              version: getVersion(),
              platform: process.platform,
              settings: JSON.stringify(safeSettings),
              // System info
              local_time: getLocalTime(),
              device_type: getDeviceType(),
              cwd: process.cwd(),
              // Session stats
              ...(() => {
                const stats = sessionStatsRef.current?.getSnapshot();
                if (!stats) return {};
                return {
                  total_api_ms: stats.totalApiMs,
                  total_wall_ms: stats.totalWallMs,
                  step_count: stats.usage.stepCount,
                  prompt_tokens: stats.usage.promptTokens,
                  completion_tokens: stats.usage.completionTokens,
                  total_tokens: stats.usage.totalTokens,
                  cached_input_tokens: stats.usage.cachedInputTokens,
                  cache_write_tokens: stats.usage.cacheWriteTokens,
                  reasoning_tokens: stats.usage.reasoningTokens,
                  context_tokens: stats.usage.contextTokens,
                };
              })(),
              // Agent info
              agent_name: agentName ?? undefined,
              agent_description: agentDescription ?? undefined,
              model: currentModelId ?? undefined,
              // Account info
              billing_tier: billingTier ?? undefined,
              server_version: telemetry.getServerVersion() ?? undefined,
              // Recent chunk log for diagnostics
              recent_chunks: chunkLog.getEntries(),
              // Debug log tail for diagnostics
              debug_log_tail: debugLogFile.getTail(),
            },
          );

          cmd.finish(
            "Feedback submitted! To chat with the Letta dev team live, join our Discord (https://discord.gg/letta).",
            true,
          );
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to send feedback: ${errorDetails}`);
        }
      });
    },
    [
      agentId,
      agentName,
      agentDescription,
      currentModelId,
      billingTier,
      commandRunner,
      consumeOverlayCommand,
      withCommandLock,
      closeOverlay,
    ],
  );

  return { handleFeedbackSubmit };
}
