import { LETTA_CLOUD_API_URL } from "../../auth/oauth";
import { apiRequest } from "./request";

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

export async function submitFeedbackMetadata(
  apiKey: string | undefined,
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await apiRequest<void>("POST", "/v1/metadata/feedback", payload, {
    baseUrl: LETTA_CLOUD_API_URL,
    apiKey: apiKey ?? "",
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
  await apiRequest<void>("POST", "/v1/metadata/telemetry", payload, {
    baseUrl: LETTA_CLOUD_API_URL,
    apiKey: apiKey ?? "",
    headers: {
      "X-Letta-Code-Device-ID": deviceId,
    },
    signal: options?.signal,
  });
}
