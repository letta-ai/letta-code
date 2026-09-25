import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { isLoopbackUrl } from "@/utils/url";
import { apiRequest, getApiRequestConfig } from "./request";

export interface BalanceMetadata {
  total_balance: number;
  monthly_credit_balance: number;
  purchased_credit_balance: number;
  billing_tier: string;
}

type QuotaBucket = "empty" | "low" | "medium" | "high" | "full";

interface ModelTierQuota {
  bucket: QuotaBucket;
  dailyBucket?: QuotaBucket;
}

export interface ModelQuotaMetadata {
  lettaTier: ModelTierQuota;
  quotaWindowEnd: string;
  dailyQuotaWindowEnd?: string;
}

export type FeedbackClientType = "desktop" | "chat.letta.com" | "cli";

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

export async function getModelQuotaMetadata(): Promise<ModelQuotaMetadata> {
  return apiRequest<ModelQuotaMetadata>("GET", "/v1/organizations/self/quotas");
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
  // Resolve credentials through the central config so Desktop OAuth tokens
  // and secure-token API keys are included. Callers often pass an apiKey
  // resolved only from the environment and non-secure settings: under
  // Desktop, initializeDesktopCredentials deletes LETTA_API_KEY from the
  // environment (the grant lives in the desktop credentials session), so a
  // cloud-targeted request would otherwise go out without any Authorization
  // header and be rejected.
  let resolved: { baseUrl: string; apiKey: string } | null = null;
  try {
    resolved = await getApiRequestConfig();
  } catch {
    // Settings unavailable; fall back to the caller-provided key below.
  }

  if (
    !isDesktopListenerRuntime() ||
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL === "1"
  ) {
    return {
      baseUrl: LETTA_CLOUD_API_URL,
      apiKey: resolved?.apiKey || apiKey || "",
    };
  }

  if (resolved && isLoopbackUrl(resolved.baseUrl)) {
    return resolved;
  }

  return {
    baseUrl: LETTA_CLOUD_API_URL,
    apiKey: resolved?.apiKey || apiKey || "",
  };
}

export async function submitFeedbackMetadata(
  apiKey: string | undefined,
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const config = await getMetadataRequestConfig(apiKey);
  await apiRequest<void>("POST", "/v1/metadata/feedback", payload, {
    ...config,
    headers: {
      "X-Letta-Code-Device-ID": deviceId,
    },
  });
}

export async function submitTelemetryMetadata(
  apiKey: string | undefined,
  deviceId: string,
  payload: Record<string, unknown>,
  options?: { signal?: AbortSignal; actingUserId?: string | null },
): Promise<void> {
  const config = await getMetadataRequestConfig(apiKey);
  await apiRequest<void>("POST", "/v1/metadata/telemetry", payload, {
    ...config,
    // Telemetry snapshots the acting user when the event is created. `null`
    // prevents a later headless env value from replacing an empty snapshot.
    actingUserId: options?.actingUserId ?? null,
    headers: {
      "X-Letta-Code-Device-ID": deviceId,
    },
    signal: options?.signal,
  });
}
