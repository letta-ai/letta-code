import { submitFeedbackMetadata } from "@/backend/api/metadata";
import { settingsManager } from "@/settings-manager";
import { getVersion } from "@/version";
import {
  type ChannelLifecycleErrorKind,
  getChannelLifecycleErrorDisplay,
} from "./lifecycle-error";
import type { ChannelTurnSource } from "./types";

const ERROR_REPORT_MESSAGE_MAX = 1000;

export interface ChannelLifecycleErrorReport {
  channel: string;
  accountId?: string;
  agentId?: string;
  conversationId?: string;
  errorKind: ChannelLifecycleErrorKind;
  errorMessage: string;
  runId?: string;
}

export type ChannelLifecycleErrorReportSubmitter = (
  report: ChannelLifecycleErrorReport,
) => Promise<void>;

let submitOverride: ChannelLifecycleErrorReportSubmitter | null = null;

function truncateReportMessage(message: string): string {
  if (message.length <= ERROR_REPORT_MESSAGE_MAX) return message;
  return `${message.slice(0, ERROR_REPORT_MESSAGE_MAX - 1).trimEnd()}…`;
}

function withDefinedValues(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

export function buildChannelLifecycleErrorReport(
  source: ChannelTurnSource,
  errorText: string | null | undefined,
  options: { runId?: string | null } = {},
): ChannelLifecycleErrorReport {
  const display = getChannelLifecycleErrorDisplay(errorText, {
    runId: options.runId,
  });
  return {
    channel: source.channel,
    accountId: source.accountId,
    agentId: source.agentId,
    conversationId: source.conversationId,
    runId: display.runId,
    errorKind: display.kind,
    errorMessage: truncateReportMessage(display.body),
  };
}

export function buildChannelLifecycleErrorReportPayload(
  report: ChannelLifecycleErrorReport,
): Record<string, unknown> {
  return withDefinedValues({
    message: "Channel lifecycle error report",
    feature: "letta-code-channel-lifecycle-error",
    version: getVersion(),
    platform: process.platform,
    channel: report.channel,
    account_id: report.accountId,
    agent_id: report.agentId,
    conversation_id: report.conversationId,
    run_id: report.runId,
    error_type: report.errorKind,
    error_message: report.errorMessage,
  });
}

export async function submitChannelLifecycleErrorReport(
  report: ChannelLifecycleErrorReport,
): Promise<void> {
  if (submitOverride) {
    await submitOverride(report);
    return;
  }

  const settings = settingsManager.getSettings();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  await submitFeedbackMetadata(
    apiKey,
    settingsManager.getOrCreateDeviceId(),
    buildChannelLifecycleErrorReportPayload(report),
  );
}

export function __testOverrideSubmitChannelLifecycleErrorReport(
  submitter: ChannelLifecycleErrorReportSubmitter | null,
): void {
  submitOverride = submitter;
}
