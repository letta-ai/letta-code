import { arch, release, type } from "node:os";
import { getVersion } from "@/version";

const CLIENT_METADATA_HEADER_MAX_LENGTH = 160;
const DESKTOP_MANAGED_ENV = "LETTA_CODE_DESKTOP_MANAGED";

function replaceHeaderUnsafeCharacters(value: string): string {
  let sanitized = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint < 32 || codePoint === 127 ? " " : character;
  }

  return sanitized;
}

function sanitizeHeaderValue(value: string): string {
  const normalized = replaceHeaderUnsafeCharacters(value)
    .replace(/\s+/g, " ")
    .trim();

  return normalized.slice(0, CLIENT_METADATA_HEADER_MAX_LENGTH);
}

function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const sanitized = sanitizeHeaderValue(value);
  if (sanitized.length > 0) {
    headers[name] = sanitized;
  }
}

function getRuntimeName(): string {
  return process.versions.bun ? "bun" : "node";
}

function getRuntimeVersion(): string {
  return process.versions.bun ?? process.versions.node;
}

export function getLettaCodeEnvironment(): string {
  return process.env[DESKTOP_MANAGED_ENV] === "1" ? "desktop" : "cli";
}

export function getLettaCodeUserAgent(): string {
  return `letta-code/${getVersion()}`;
}

export function getLettaCodeClientMetadataHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  setHeader(headers, "X-Letta-Client-Name", "letta-code");
  setHeader(headers, "X-Letta-Client-Version", getVersion());
  setHeader(headers, "X-Letta-Client-Platform", process.platform);
  setHeader(headers, "X-Letta-Client-OS-Type", type());
  setHeader(headers, "X-Letta-Client-OS-Release", release());
  setHeader(headers, "X-Letta-Client-Arch", arch());
  setHeader(headers, "X-Letta-Client-Runtime", getRuntimeName());
  setHeader(headers, "X-Letta-Client-Runtime-Version", getRuntimeVersion());
  setHeader(headers, "X-Letta-Client-Environment", getLettaCodeEnvironment());

  return headers;
}

export function getLettaCodeRequestHeaders(): Record<string, string> {
  return {
    "User-Agent": getLettaCodeUserAgent(),
    "X-Letta-Source": "letta-code",
    ...getLettaCodeClientMetadataHeaders(),
  };
}
