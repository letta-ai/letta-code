import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";
import { getLettaCodeHeaders } from "./http-headers";

export type ApiRequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface NotificationSponsorshipRequest {
  deliveryId: string;
  clientMessageId: string;
}

export type NotificationSponsorshipExchangeResult =
  | { kind: "capability"; capability: string }
  | { kind: "receipt"; admissionState: "admitting" | "core_accepted" };

export const NOTIFICATION_SPONSORSHIP_CAPABILITY_HEADER =
  "x-letta-notification-sponsorship";

export class NotificationSponsorshipExchangeError extends Error {
  constructor(readonly status: number) {
    super("Notification sponsorship exchange failed");
    this.name = "NotificationSponsorshipExchangeError";
  }
}

export function parseNotificationSponsorshipExchange(
  value: unknown,
): NotificationSponsorshipExchangeResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Notification sponsorship exchange returned an invalid receipt",
    );
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.admission_state === "admitting" ||
    receipt.admission_state === "core_accepted"
  ) {
    const coreAccepted = receipt.admission_state === "core_accepted";
    const validCoreIds = coreAccepted
      ? typeof receipt.core_message_id === "string" &&
        receipt.core_message_id.length > 0 &&
        typeof receipt.core_run_id === "string" &&
        receipt.core_run_id.length > 0
      : receipt.core_message_id === null && receipt.core_run_id === null;
    if (
      typeof receipt.request_id !== "string" ||
      receipt.request_id.length === 0 ||
      !validCoreIds ||
      Object.keys(receipt).length !== 4
    ) {
      throw new Error(
        "Notification sponsorship exchange returned an invalid receipt",
      );
    }
    return { kind: "receipt", admissionState: receipt.admission_state };
  }
  if (
    receipt.admission_state === "new" &&
    typeof receipt.capability === "string" &&
    receipt.capability.length > 0 &&
    typeof receipt.expires_at === "string" &&
    Number.isFinite(Date.parse(receipt.expires_at)) &&
    Object.keys(receipt).length === 3
  ) {
    return { kind: "capability", capability: receipt.capability };
  }
  throw new Error(
    "Notification sponsorship exchange returned an invalid receipt",
  );
}

/** Exchange a non-secret delivery reference for a one-request capability. */
export async function exchangeNotificationSponsorship(
  request: NotificationSponsorshipRequest,
  signal?: AbortSignal,
): Promise<NotificationSponsorshipExchangeResult> {
  const { deliveryId, clientMessageId } = request;
  if (!deliveryId || !clientMessageId) {
    throw new Error("Notification sponsorship reference is invalid");
  }
  const response = await apiFetch(
    `/v1/internal/agent-notification-deliveries/${encodeURIComponent(deliveryId)}/sponsorship`,
    {
      method: "POST",
      body: { client_message_id: clientMessageId },
      signal,
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!response.ok) {
    // Do not retain or surface raw response bodies; they may contain secrets.
    throw new NotificationSponsorshipExchangeError(response.status);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Notification sponsorship exchange returned invalid JSON");
  }
  return parseNotificationSponsorshipExchange(value);
}

export interface ApiRequestConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ApiFetchOptions {
  method?: ApiRequestMethod;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  baseUrl?: string;
  apiKey?: string;
  /** `null` suppresses the inherited headless acting user for this request. */
  actingUserId?: string | null;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
    readonly headers?: Headers,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function getApiRequestConfig(): Promise<ApiRequestConfig> {
  const settings = await settingsManager.getSettingsWithSecureTokens();
  return {
    baseUrl:
      process.env.LETTA_BASE_URL ||
      settings.env?.LETTA_BASE_URL ||
      LETTA_CLOUD_API_URL,
    apiKey:
      getDesktopAccessToken() ||
      process.env.LETTA_API_KEY ||
      settings.env?.LETTA_API_KEY ||
      "",
  };
}

function maybeMapKnownApiError(
  status: number,
  responseText: string,
): Error | null {
  if (status !== 403) {
    return null;
  }

  try {
    const errorData = JSON.parse(responseText) as { error?: unknown };
    if (
      typeof errorData.error === "string" &&
      errorData.error.includes("only available for pro or enterprise")
    ) {
      return new Error("PLAN_UPGRADE_REQUIRED");
    }
  } catch {
    // Fall through to the generic API error below.
  }

  return null;
}

/**
 * Centralized seam for direct Letta API fetches that are not covered by the
 * generated SDK. Keep raw route fetches here so local-mode can swap this layer
 * without hunting through UI/agent code.
 */
export async function apiFetch(
  path: string,
  options: ApiFetchOptions = {},
): Promise<Response> {
  const config =
    options.baseUrl === undefined || options.apiKey === undefined
      ? await getApiRequestConfig()
      : null;
  const baseUrl = options.baseUrl ?? config?.baseUrl;
  const apiKey = options.apiKey ?? config?.apiKey ?? "";

  if (!baseUrl) {
    throw new Error("Missing Letta API base URL");
  }

  const url = new URL(`${baseUrl}${path}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...getLettaCodeHeaders(apiKey, options.actingUserId),
      ...options.headers,
    },
    ...(options.body && { body: JSON.stringify(options.body) }),
    ...(options.signal && { signal: options.signal }),
  });
}

export async function apiRequest<T>(
  method: ApiRequestMethod,
  path: string,
  body?: Record<string, unknown>,
  options: Omit<ApiFetchOptions, "method" | "body"> = {},
): Promise<T> {
  const response = await apiFetch(path, {
    ...options,
    method,
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    const mapped = maybeMapKnownApiError(response.status, text);
    if (mapped) {
      throw mapped;
    }
    throw new ApiRequestError(
      `API error (${response.status}): ${text}`,
      response.status,
      text,
      response.headers,
    );
  }

  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}
