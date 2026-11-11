import { getLettaCodeHeaders } from "@/backend/api/http-headers";
import {
  type ApiRequestConfig,
  ApiRequestError,
  getApiRequestConfig,
} from "@/backend/api/request";

export interface ConversationSandbox {
  sandboxId: string;
  deviceId: string;
  connectionName: string;
  conversationId?: string;
  resumed?: boolean;
}

export interface SandboxFileMetadata {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface SandboxFilesApiDeps {
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  getConfig: () => Promise<ApiRequestConfig>;
}

const defaultDeps: SandboxFilesApiDeps = {
  fetch: globalThis.fetch,
  getConfig: getApiRequestConfig,
};

async function throwResponseError(response: Response): Promise<never> {
  const text = await response.text();
  throw new ApiRequestError(
    `API error (${response.status}): ${text}`,
    response.status,
    text,
  );
}

async function request(
  path: string,
  init: RequestInit,
  deps: SandboxFilesApiDeps,
): Promise<Response> {
  const config = await deps.getConfig();
  const headers = new Headers(getLettaCodeHeaders(config.apiKey));
  new Headers(init.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  if (init.body instanceof FormData) {
    headers.delete("Content-Type");
  }
  const response = await deps.fetch(new URL(path, config.baseUrl), {
    ...init,
    headers,
  });
  if (!response.ok) await throwResponseError(response);
  return response;
}

export async function ensureConversationSandbox(
  agentId: string,
  conversationId: string,
  deps: SandboxFilesApiDeps = defaultDeps,
): Promise<ConversationSandbox> {
  const response = await request(
    `/v1/agents/${encodeURIComponent(agentId)}/sandboxes`,
    {
      method: "POST",
      body: JSON.stringify(
        conversationId === "default" ? {} : { conversationId },
      ),
    },
    deps,
  );
  return (await response.json()) as ConversationSandbox;
}

export async function uploadFileToSandbox(
  sandboxId: string,
  file: { blob: Blob; name: string },
  deps: SandboxFilesApiDeps = defaultDeps,
): Promise<{ files: SandboxFileMetadata[] }> {
  const form = new FormData();
  form.append("file", file.blob, file.name);
  const response = await request(
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`,
    {
      method: "POST",
      body: form,
    },
    deps,
  );
  return (await response.json()) as { files: SandboxFileMetadata[] };
}

export interface SandboxDesktopSession {
  /** Optional browser viewer URL supplied by the server. */
  viewerUrl?: string;
  /**
   * Relay websocket URL. Servers that honor `websocketProtocolAuth` return it
   * without credentials and put the relay token in `protocols` instead.
   */
  url: string;
  /** WebSocket subprotocols carrying the relay token; treat them as secrets. */
  protocols?: string[];
  expiresAt: string;
}

export interface SandboxExposure {
  url: string;
  port: number;
  expiresAt: string;
  private?: boolean;
}

export type SandboxExposureExpiry =
  | { expiresInSeconds: number }
  | { extendBySeconds: number };

export interface SandboxExposureOptions {
  public?: boolean;
}

export async function createSandboxExposure(
  port: number,
  expiry: SandboxExposureExpiry,
  options: SandboxExposureOptions = {},
  deps: SandboxFilesApiDeps = defaultDeps,
): Promise<SandboxExposure> {
  const response = await request(
    "/v1/sandbox-exposures",
    {
      method: "POST",
      body: JSON.stringify({ port, ...expiry, ...options }),
      headers: { "Content-Type": "application/json" },
    },
    deps,
  );
  return (await response.json()) as SandboxExposure;
}

/**
 * Start the sandbox's graphical desktop and mint a short-lived relay session.
 * The server fixes the lifetime (one hour today). `websocketProtocolAuth`
 * asks for the relay token in Sec-WebSocket-Protocol rather than the relay
 * URL's query string, so it never lands in a request log.
 */
export async function createSandboxDesktopSession(
  sandboxId: string,
  deps: SandboxFilesApiDeps = defaultDeps,
): Promise<SandboxDesktopSession> {
  const response = await request(
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/desktop-session`,
    {
      method: "POST",
      body: JSON.stringify({ websocketProtocolAuth: true }),
      headers: { "Content-Type": "application/json" },
    },
    deps,
  );
  return (await response.json()) as SandboxDesktopSession;
}

export async function downloadFileFromSandbox(
  sandboxId: string,
  path: string,
  deps: SandboxFilesApiDeps = defaultDeps,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ path });
  const response = await request(
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query}`,
    { method: "GET" },
    deps,
  );
  return new Uint8Array(await response.arrayBuffer());
}
