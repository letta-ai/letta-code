import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

const INVALID_AUTHORIZATION_HEADER_MESSAGE = "invalid authorization header";

export type WebsocketAuthCliMode = "capability-token";

export interface AppServerWebsocketAuthArgs {
  wsAuth?: string;
  wsTokenFile?: string;
  wsTokenSha256?: string;
}

export interface AppServerWebsocketAuthSettings {
  config?: AppServerWebsocketAuthConfig;
}

export type AppServerWebsocketAuthConfig = {
  mode: WebsocketAuthCliMode;
  source: AppServerWebsocketCapabilityTokenSource;
};

export type AppServerWebsocketCapabilityTokenSource =
  | { type: "token-file"; tokenFile: string }
  | { type: "token-sha256"; tokenSha256: Buffer };

export interface WebsocketAuthPolicy {
  mode?: WebsocketAuthMode;
}

type WebsocketAuthMode = {
  type: "capability-token";
  tokenSha256: Buffer;
};

export interface WebsocketAuthError {
  statusCode: number;
  message: string;
}

export function parseAppServerWebsocketAuthSettings(
  args: AppServerWebsocketAuthArgs,
): AppServerWebsocketAuthSettings {
  switch (args.wsAuth) {
    case undefined:
      if (args.wsTokenFile || args.wsTokenSha256) {
        throw new Error(
          "websocket auth flags require `--ws-auth capability-token`",
        );
      }
      return {};
    case "capability-token": {
      const hasTokenFile = Boolean(args.wsTokenFile);
      const hasTokenSha256 = Boolean(args.wsTokenSha256);
      if (hasTokenFile && hasTokenSha256) {
        throw new Error(
          "`--ws-token-file` and `--ws-token-sha256` are mutually exclusive",
        );
      }
      if (!hasTokenFile && !hasTokenSha256) {
        throw new Error(
          "`--ws-token-file` or `--ws-token-sha256` is required when `--ws-auth capability-token` is set",
        );
      }
      return {
        config: {
          mode: "capability-token",
          source: args.wsTokenFile
            ? {
                type: "token-file",
                tokenFile: absolutePathArg("--ws-token-file", args.wsTokenFile),
              }
            : {
                type: "token-sha256",
                tokenSha256: sha256DigestArg(
                  "--ws-token-sha256",
                  args.wsTokenSha256 as string,
                ),
              },
        },
      };
    }
    default:
      throw new Error(
        `unsupported --ws-auth mode "${args.wsAuth}"; expected "capability-token"`,
      );
  }
}

export async function policyFromSettings(
  settings: AppServerWebsocketAuthSettings = {},
): Promise<WebsocketAuthPolicy> {
  const config = settings.config;
  if (!config) {
    return {};
  }

  switch (config.mode) {
    case "capability-token":
      return {
        mode: {
          type: "capability-token",
          tokenSha256:
            config.source.type === "token-file"
              ? sha256Digest(await readTrimmedSecret(config.source.tokenFile))
              : config.source.tokenSha256,
        },
      };
  }
}

export function isUnauthenticatedNonLoopbackListener(
  host: string,
  policy: WebsocketAuthPolicy,
): boolean {
  return !isLoopbackListenHost(host) && !policy.mode;
}

export function isLoopbackListenHost(host: string): boolean {
  const normalized = normalizeListenHost(host);
  if (normalized === "localhost") {
    return true;
  }
  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }
  return normalized === "::1";
}

export function normalizeListenHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

export function authorizeUpgrade(
  headers: IncomingHttpHeaders,
  policy: WebsocketAuthPolicy,
): WebsocketAuthError | null {
  const mode = policy.mode;
  if (!mode) {
    return null;
  }

  const tokenResult = bearerTokenFromHeaders(headers);
  if (typeof tokenResult !== "string") {
    return tokenResult;
  }

  switch (mode.type) {
    case "capability-token": {
      const actualSha256 = sha256Digest(tokenResult);
      if (timingSafeEqual(mode.tokenSha256, actualSha256)) {
        return null;
      }
      return unauthorized("invalid websocket bearer token");
    }
  }
}

function bearerTokenFromHeaders(
  headers: IncomingHttpHeaders,
): string | WebsocketAuthError {
  const rawHeader = headers.authorization;
  if (rawHeader === undefined) {
    return unauthorized("missing websocket bearer token");
  }
  if (Array.isArray(rawHeader)) {
    return unauthorized(INVALID_AUTHORIZATION_HEADER_MESSAGE);
  }

  const separatorIndex = rawHeader.indexOf(" ");
  if (separatorIndex === -1) {
    return unauthorized(INVALID_AUTHORIZATION_HEADER_MESSAGE);
  }
  const scheme = rawHeader.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== "bearer") {
    return unauthorized(INVALID_AUTHORIZATION_HEADER_MESSAGE);
  }

  const token = rawHeader.slice(separatorIndex + 1).trim();
  if (!token) {
    return unauthorized(INVALID_AUTHORIZATION_HEADER_MESSAGE);
  }
  return token;
}

async function readTrimmedSecret(path: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read websocket auth secret ${path}: ${message}`);
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`websocket auth secret ${path} must not be empty`);
  }
  return trimmed;
}

function absolutePathArg(flagName: string, path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${flagName} must be an absolute path`);
  }
  return path;
}

function sha256DigestArg(flagName: string, value: string): Buffer {
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`${flagName} must be a 64-character hex SHA-256 digest`);
  }
  return Buffer.from(trimmed, "hex");
}

function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function unauthorized(message: string): WebsocketAuthError {
  return { statusCode: 401, message };
}
