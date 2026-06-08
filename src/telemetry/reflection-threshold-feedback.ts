import { randomUUID } from "node:crypto";
import { submitFeedbackMetadata } from "@/backend/api/metadata";
import { settingsManager } from "@/settings-manager";
import { type ReflectionTriggerSource, telemetry } from "@/telemetry";

const REFLECTION_DURATION_THRESHOLD_MS = 10 * 60 * 1000;
const REFLECTION_STEP_COUNT_THRESHOLD = 100;

export type ReflectionThresholdFeedbackOptions = {
  parentAgentId: string;
  parentAgentName?: string | null;
  parentAgentDescription?: string | null;
  reflectionSubagentId?: string;
  conversationId?: string;
  triggerSource: ReflectionTriggerSource;
  success: boolean;
  error?: string;
  stepCount?: number;
  durationMs?: number;
  surface?: string;
  model?: string | null;
};

async function resolveFeedbackApiKey(): Promise<string | undefined> {
  const settings = await settingsManager.getSettingsWithSecureTokens();
  return process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
}

function getFeedbackDeviceId(): string {
  try {
    const deviceId = settingsManager.getOrCreateDeviceId().trim();
    if (deviceId) {
      return deviceId;
    }
  } catch {
    // Fall back below.
  }
  return randomUUID();
}

function getAlertReasonDescriptions(alertReasons: string[]): string[] {
  return alertReasons.map((reason) => {
    switch (reason) {
      case "duration_gt_10m":
        return "longer than 10 minutes";
      case "step_count_gt_100":
        return "over 100 steps";
      default:
        return reason;
    }
  });
}

function getAlertReasons(
  options: ReflectionThresholdFeedbackOptions,
): string[] {
  const alertReasons: string[] = [];
  if (
    typeof options.durationMs === "number" &&
    options.durationMs > REFLECTION_DURATION_THRESHOLD_MS
  ) {
    alertReasons.push("duration_gt_10m");
  }
  if (
    typeof options.stepCount === "number" &&
    options.stepCount > REFLECTION_STEP_COUNT_THRESHOLD
  ) {
    alertReasons.push("step_count_gt_100");
  }
  return alertReasons;
}

export function maybeSendReflectionThresholdFeedback(
  options: ReflectionThresholdFeedbackOptions,
): void {
  const alertReasons = getAlertReasons(options);
  if (alertReasons.length === 0) {
    return;
  }

  const alertReasonDescriptions = getAlertReasonDescriptions(alertReasons);
  const stepCountText =
    typeof options.stepCount === "number"
      ? String(options.stepCount)
      : "unknown";
  const durationMinutesText =
    typeof options.durationMs === "number"
      ? (options.durationMs / (60 * 1000)).toFixed(1)
      : "unknown";
  const thresholdDescription = alertReasonDescriptions.join(", ");
  const reflectionSubagentId = options.reflectionSubagentId ?? "unset";
  const agentId = options.reflectionSubagentId ?? options.parentAgentId;

  void (async () => {
    const apiKey = await resolveFeedbackApiKey();
    await submitFeedbackMetadata(apiKey, getFeedbackDeviceId(), {
      message:
        `[REFLECTION THRESHOLD ALERT] ${stepCountText} step / ` +
        `${durationMinutesText} minute reflection is ${thresholdDescription} ` +
        `(parent agent ID: ${options.parentAgentId}, ` +
        `reflection subagent ID: ${reflectionSubagentId})`,
      feature: "letta-code",
      agent_id: agentId,
      session_id: telemetry.getSessionId(),
      total_wall_ms: options.durationMs,
      step_count: options.stepCount,
      agent_name: options.parentAgentName ?? undefined,
      agent_description: options.parentAgentDescription ?? undefined,
      model: options.model ?? undefined,
      server_version: telemetry.getServerVersion() ?? undefined,
      settings: JSON.stringify({
        source: "reflection_threshold_alert",
        alert_reasons: alertReasons,
        alert_reason_descriptions: alertReasonDescriptions,
        trigger_source: options.triggerSource,
        success: options.success,
        parent_agent_id: options.parentAgentId,
        reflection_subagent_id: options.reflectionSubagentId,
        subagent_id: options.reflectionSubagentId,
        conversation_id: options.conversationId,
        error: options.error,
        surface: options.surface,
      }),
    });
  })().catch(() => {
    // Feedback alerts are best-effort and should never affect reflection flow.
  });
}
