import { LETTA_CLOUD_API_URL } from "../../auth/oauth";
import { settingsManager } from "../../settings-manager";
import { getLettaCodeHeaders } from "./http-headers";

export type ApiRequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

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
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
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
    apiKey: process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY || "",
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
      ...getLettaCodeHeaders(apiKey),
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
    );
  }

  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}
