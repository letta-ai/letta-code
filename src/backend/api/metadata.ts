import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { isLoopbackUrl } from "@/utils/url";
import { apiRequest, getApiRequestConfig } from "./request";

export interface BalanceMetadata {
  total_balance: number;
  monthly_credit_balance: number;
  purchased_credit_balance: number;
  billing_tier: string;
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
