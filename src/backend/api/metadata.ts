import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { isLoopbackUrl } from "@/utils/url";
import { apiRequest, getApiRequestConfig } from "./request";

export interface BalanceMetadata {
  total_balance: number;
  monthly_credit_balance: number;
  purchased_credit_balance: number;
  billing_tier: string;
}

export type FeedbackClientType = "desktop" | "chat.letta.com" | "cli";

export interface FeedbackResult {
  success: boolean;
  status?: "accepted" | "rejected";
  message?: string;
}

export function parseFeedbackResult(value: unknown): FeedbackResult {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid feedback response");
  const result = value as Record<string, unknown>;
  if (
    typeof result.success !== "boolean" ||
    (result.status !== undefined &&
      result.status !== "accepted" &&
      result.status !== "rejected") ||
    (result.status === "accepted" && !result.success) ||
    (result.status === "rejected" && result.success) ||
    (result.message !== undefined &&
      (typeof result.message !== "string" || !result.message.trim()))
  ) {
    throw new Error("Invalid feedback response");
  }
  return result as unknown as FeedbackResult;
}

export function feedbackResultMessage(result: FeedbackResult): string {
  return (
    result.message ??
    (result.success
      ? "Feedback submitted. Thanks for helping improve Letta Code."
      : "Feedback was not accepted. Do not resubmit this report.")
  );
}

export function getFeedbackClientType(
  env: NodeJS.ProcessEnv = process.env,
): FeedbackClientType {
  if (env.LETTA_DESKTOP_MODE === "1") {
    return "desktop";
  }
  if (env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID) {
    return "chat.letta.com";
  }
  return "cli";
}

export async function getBalanceMetadata(): Promise<BalanceMetadata> {
  return apiRequest<BalanceMetadata>("GET", "/v1/metadata/balance");
}

export async function getBillingTier(): Promise<string | null> {
  try {
    const balance = await getBalanceMetadata();
    return balance.billing_tier ?? null;
  } catch {
    return null;
  }
}

function isDesktopListenerRuntime(): boolean {
  return process.env.LETTA_DESKTOP_MODE === "1";
}

async function getMetadataRequestConfig(
  apiKey: string | undefined,
): Promise<{ baseUrl: string; apiKey: string }> {
  if (
    !isDesktopListenerRuntime() ||
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL === "1"
  ) {
    return { baseUrl: LETTA_CLOUD_API_URL, apiKey: apiKey ?? "" };
  }

  const config = await getApiRequestConfig();

  if (isLoopbackUrl(config.baseUrl)) {
    return config;
  }

  return { baseUrl: LETTA_CLOUD_API_URL, apiKey: apiKey ?? "" };
}

export async function submitFeedbackMetadata(
  apiKey: string | undefined,
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<FeedbackResult> {
  const config = await getMetadataRequestConfig(apiKey);
  const result = await apiRequest<unknown>(
    "POST",
    "/v1/metadata/feedback",
    payload,
    {
      ...config,
      headers: {
        "X-Letta-Code-Device-ID": deviceId,
      },
    },
  );
  return parseFeedbackResult(result);
}

export async function submitTelemetryMetadata(
  apiKey: string | undefined,
  deviceId: string,
  payload: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const config = await getMetadataRequestConfig(apiKey);
  await apiRequest<void>("POST", "/v1/metadata/telemetry", payload, {
    ...config,
    headers: {
      "X-Letta-Code-Device-ID": deviceId,
    },
    signal: options?.signal,
  });
}
