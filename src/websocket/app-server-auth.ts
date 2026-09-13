import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

const INVALID_AUTHORIZATION_HEADER_MESSAGE = "invalid authorization header";
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 30;
const MIN_SIGNED_BEARER_SECRET_BYTES = 32;

export type WebsocketAuthCliMode = "capability-token" | "signed-bearer-token";

export interface AppServerWebsocketAuthArgs {
  wsAuth?: string;
  wsTokenFile?: string;
  wsTokenSha256?: string;
  wsSharedSecretFile?: string;
  wsIssuer?: string;
  wsAudience?: string;
  wsMaxClockSkewSeconds?: string | number;
}

export interface AppServerWebsocketAuthSettings {
  config?: AppServerWebsocketAuthConfig;
}

export type AppServerWebsocketAuthConfig =
  | {
      mode: "capability-token";
      source: AppServerWebsocketCapabilityTokenSource;
    }
  | {
      mode: "signed-bearer-token";
      sharedSecretFile: string;
      issuer?: string;
      audience?: string;
      maxClockSkewSeconds: number;
    };

export type AppServerWebsocketCapabilityTokenSource =
  | { type: "token-file"; tokenFile: string }
  | { type: "token-sha256"; tokenSha256: Buffer };

export interface WebsocketAuthPolicy {
  mode?: WebsocketAuthMode;
}

type WebsocketAuthMode =
  | {
      type: "capability-token";
      tokenSha256: Buffer;
    }
  | {
      type: "signed-bearer-token";
      sharedSecret: Buffer;
      issuer?: string;
      audience?: string;
      maxClockSkewSeconds: number;
    };

export interface WebsocketAuthError {
  statusCode: number;
  message: string;
}

export function parseAppServerWebsocketAuthSettings(
  args: AppServerWebsocketAuthArgs,
): AppServerWebsocketAuthSettings {
  const hasSignedBearerFlag = Boolean(
    args.wsSharedSecretFile !== undefined ||
      args.wsIssuer !== undefined ||
      args.wsAudience !== undefined ||
      args.wsMaxClockSkewSeconds !== undefined,
  );
  switch (args.wsAuth) {
    case undefined:
      if (
        args.wsTokenFile !== undefined ||
        args.wsTokenSha256 !== undefined ||
        hasSignedBearerFlag
      ) {
        throw new Error(
          "websocket auth flags require `--ws-auth capability-token` or `--ws-auth signed-bearer-token`",
        );
      }
      return {};
    case "capability-token": {
      if (hasSignedBearerFlag) {
        throw new Error(
          "`--ws-shared-secret-file`, `--ws-issuer`, `--ws-audience`, and `--ws-max-clock-skew-seconds` require `--ws-auth signed-bearer-token`",
        );
      }
      const hasTokenFile = args.wsTokenFile !== undefined;
      const hasTokenSha256 = args.wsTokenSha256 !== undefined;
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
    case "signed-bearer-token": {
      if (args.wsTokenFile !== undefined || args.wsTokenSha256 !== undefined) {
        throw new Error(
          "`--ws-token-file` and `--ws-token-sha256` require `--ws-auth capability-token`, not `signed-bearer-token`",
        );
      }
      if (args.wsSharedSecretFile === undefined) {
        throw new Error(
          "`--ws-shared-secret-file` is required when `--ws-auth signed-bearer-token` is set",
        );
      }
      return {
        config: {
          mode: "signed-bearer-token",
          sharedSecretFile: absolutePathArg(
            "--ws-shared-secret-file",
            args.wsSharedSecretFile,
          ),
          issuer: normalizeOptionalString(args.wsIssuer),
          audience: normalizeOptionalString(args.wsAudience),
          maxClockSkewSeconds:
            args.wsMaxClockSkewSeconds !== undefined
              ? nonNegativeIntegerArg(
                  "--ws-max-clock-skew-seconds",
                  args.wsMaxClockSkewSeconds,
                )
              : DEFAULT_MAX_CLOCK_SKEW_SECONDS,
        },
      };
    }
    default:
      throw new Error(
        `unsupported --ws-auth mode "${args.wsAuth}"; expected "capability-token" or "signed-bearer-token"`,
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
    case "signed-bearer-token": {
      const sharedSecret = Buffer.from(
        await readTrimmedSecret(config.sharedSecretFile),
        "utf8",
      );
      validateSignedBearerSecret(config.sharedSecretFile, sharedSecret);
      return {
        mode: {
          type: "signed-bearer-token",
          sharedSecret,
          issuer: config.issuer,
          audience: config.audience,
          maxClockSkewSeconds: config.maxClockSkewSeconds,
        },
      };
    }
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
    case "signed-bearer-token":
      return verifySignedBearerToken(
        tokenResult,
        mode.sharedSecret,
        mode.issuer,
        mode.audience,
        mode.maxClockSkewSeconds,
      );
  }
}

function verifySignedBearerToken(
  token: string,
  sharedSecret: Buffer,
  issuer: string | undefined,
  audience: string | undefined,
  maxClockSkewSeconds: number,
): WebsocketAuthError | null {
  const claims = decodeJwtClaims(token, sharedSecret);
  if ("error" in claims) {
    return claims.error;
  }
  return validateJwtClaims(
    claims.claims,
    issuer,
    audience,
    maxClockSkewSeconds,
  );
}

interface JwtClaims {
  exp: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
}

function decodeJwtClaims(
  token: string,
  sharedSecret: Buffer,
): { claims: JwtClaims } | { error: WebsocketAuthError } {
  const parts = token.split(".");
  const encodedHeader = parts[0];
  const encodedClaims = parts[1];
  const encodedSignature = parts[2];
  if (
    parts.length !== 3 ||
    !encodedHeader ||
    !encodedClaims ||
    !encodedSignature
  ) {
    return { error: unauthorized("invalid websocket jwt") };
  }

  let header: unknown;
  let claims: unknown;
  let actualSignature: Buffer;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"));
    claims = JSON.parse(base64UrlDecode(encodedClaims).toString("utf8"));
    actualSignature = base64UrlDecode(encodedSignature);
  } catch {
    return { error: unauthorized("invalid websocket jwt") };
  }

  if (!isRecord(header) || header.alg !== "HS256") {
    return { error: unauthorized("invalid websocket jwt") };
  }

  const expectedSignature = createHmac("sha256", sharedSecret)
    .update(`${encodedHeader}.${encodedClaims}`)
    .digest();
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return { error: unauthorized("invalid websocket jwt") };
  }

  if (!isJwtClaims(claims)) {
    return { error: unauthorized("invalid websocket jwt") };
  }
  return { claims };
}

function validateJwtClaims(
  claims: JwtClaims,
  issuer: string | undefined,
  audience: string | undefined,
  maxClockSkewSeconds: number,
): WebsocketAuthError | null {
  const now = Math.floor(Date.now() / 1000);
  if (now > claims.exp + maxClockSkewSeconds) {
    return unauthorized("expired websocket jwt");
  }
  if (claims.nbf !== undefined && now < claims.nbf - maxClockSkewSeconds) {
    return unauthorized("websocket jwt is not valid yet");
  }
  if (issuer !== undefined && claims.iss !== issuer) {
    return unauthorized("websocket jwt issuer mismatch");
  }
  if (audience !== undefined && !audienceMatches(claims.aud, audience)) {
    return unauthorized("websocket jwt audience mismatch");
  }
  return null;
}

function audienceMatches(
  actual: JwtClaims["aud"],
  expectedAudience: string,
): boolean {
  if (typeof actual === "string") {
    return actual === expectedAudience;
  }
  if (Array.isArray(actual)) {
    return actual.some((audience) => audience === expectedAudience);
  }
  return false;
}

function isJwtClaims(value: unknown): value is JwtClaims {
  if (!isRecord(value) || !Number.isSafeInteger(value.exp)) {
    return false;
  }
  if (value.nbf !== undefined && !Number.isSafeInteger(value.nbf)) {
    return false;
  }
  if (value.iss !== undefined && typeof value.iss !== "string") {
    return false;
  }
  if (value.aud !== undefined) {
    if (typeof value.aud === "string") {
      return true;
    }
    if (!Array.isArray(value.aud)) {
      return false;
    }
    return value.aud.every((audience) => typeof audience === "string");
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("invalid base64url");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(`${base64}${padding}`, "base64");
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

function nonNegativeIntegerArg(
  flagName: string,
  value: string | number,
): number {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateSignedBearerSecret(path: string, sharedSecret: Buffer): void {
  if (sharedSecret.length < MIN_SIGNED_BEARER_SECRET_BYTES) {
    throw new Error(
      `signed websocket bearer secret ${path} must be at least ${MIN_SIGNED_BEARER_SECRET_BYTES} bytes`,
    );
  }
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
