import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
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

function isDesktopListenerRuntime(): boolean {
  return process.env.LETTA_DESKTOP_DEBUG_PANEL === "1";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function getDesktopProxyMetadataBaseUrl(): string | undefined {
  if (
    !isDesktopListenerRuntime() ||
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL === "1"
  ) {
    return undefined;
  }

  const baseUrl = process.env.LETTA_BASE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  try {
    const parsed = new URL(baseUrl);
    if (!isLoopbackHostname(parsed.hostname)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return baseUrl.replace(/\/+$/, "");
}

function getMetadataBaseUrl(): string {
  return getDesktopProxyMetadataBaseUrl() ?? LETTA_CLOUD_API_URL;
}

export async function submitFeedbackMetadata(
  apiKey: string | undefined,
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await apiRequest<void>("POST", "/v1/metadata/feedback", payload, {
    baseUrl: getMetadataBaseUrl(),
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
    baseUrl: getMetadataBaseUrl(),
    apiKey: apiKey ?? "",
    headers: {
      "X-Letta-Code-Device-ID": deviceId,
    },
    signal: options?.signal,
  });
}
