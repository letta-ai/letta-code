import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderResponse } from "../api/providers";
import { getLocalBackendStorageDir } from "./paths";

export type LocalProviderAuthType = "api" | "oauth";

export interface LocalProviderApiAuth {
  type: "api";
  key: string;
}

export interface LocalProviderOAuthAuth {
  type: "oauth";
  access: string;
  refresh?: string;
  idToken?: string;
  expires: number;
  accountId?: string;
}

export type LocalProviderAuth = LocalProviderApiAuth | LocalProviderOAuthAuth;

export interface LocalProviderRecord {
  id: string;
  name: string;
  provider_type: string;
  provider_category: "byok";
  auth: LocalProviderAuth;
  access_key?: string;
  region?: string;
  profile?: string;
  base_url?: string;
  created_at: string;
  updated_at: string;
}

interface LocalProviderAuthFile {
  version: 1;
  providers: Record<string, LocalProviderRecord>;
}

export const LOCAL_CHATGPT_PROVIDER_NAME = "chatgpt-plus-pro";
export const LOCAL_OPENAI_PROVIDER_NAME = "lc-openai";
export const LOCAL_ANTHROPIC_PROVIDER_NAME = "lc-anthropic";
export const LOCAL_OPENROUTER_PROVIDER_NAME = "lc-openrouter";
export const LOCAL_OLLAMA_PROVIDER_NAME = "lc-ollama";
export const LOCAL_OLLAMA_CLOUD_PROVIDER_NAME = "lc-ollama-cloud";
export const LOCAL_LMSTUDIO_PROVIDER_NAME = "lc-lmstudio";
export const LOCAL_ZAI_PROVIDER_NAME = "lc-zai";
export const LOCAL_ZAI_CODING_PROVIDER_NAME = "lc-zai-coding";
export const LOCAL_MINIMAX_PROVIDER_NAME = "lc-minimax";
export const LOCAL_MOONSHOT_PROVIDER_NAME = "lc-moonshot";
export const LOCAL_KIMI_CODE_PROVIDER_NAME = "lc-kimi-code";
export const LOCAL_GOOGLE_AI_PROVIDER_NAME = "lc-gemini";
export const LOCAL_BEDROCK_PROVIDER_NAME = "lc-bedrock";

const SUPPORTED_LOCAL_PROVIDER_TYPES = new Set([
  "openai",
  "anthropic",
  "openrouter",
  "ollama",
  "ollama_cloud",
  "lmstudio",
  "zai",
  "zai_coding",
  "minimax",
  "moonshot",
  "moonshot_coding",
  "google_ai",
  "bedrock",
  "chatgpt_oauth",
]);

export function isLocalProviderTypeSupported(providerType: string): boolean {
  return SUPPORTED_LOCAL_PROVIDER_TYPES.has(providerType);
}

export function getLocalProviderAuthPath(
  storageDir = getLocalBackendStorageDir(),
): string {
  return join(storageDir, "providers", "auth.json");
}

function emptyAuthFile(): LocalProviderAuthFile {
  return { version: 1, providers: {} };
}

function readAuthFile(storageDir?: string): LocalProviderAuthFile {
  const path = getLocalProviderAuthPath(storageDir);
  if (!existsSync(path)) return emptyAuthFile();
  const parsed = JSON.parse(
    readFileSync(path, "utf8"),
  ) as Partial<LocalProviderAuthFile>;
  return {
    version: 1,
    providers:
      parsed.providers && typeof parsed.providers === "object"
        ? parsed.providers
        : {},
  };
}

function writeAuthFile(file: LocalProviderAuthFile, storageDir?: string): void {
  const path = getLocalProviderAuthPath(storageDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function providerId(providerName: string): string {
  return `local-provider-${providerName}`;
}

function providerResponse(record: LocalProviderRecord): ProviderResponse {
  return {
    id: record.id,
    name: record.name,
    provider_type: record.provider_type,
    provider_category: record.provider_category,
    ...(record.base_url ? { base_url: record.base_url } : {}),
    ...(record.access_key ? { access_key: record.access_key } : {}),
    ...(record.region ? { region: record.region } : {}),
  };
}

export function listLocalProviderRecords(
  storageDir?: string,
): LocalProviderRecord[] {
  return Object.values(readAuthFile(storageDir).providers);
}

export async function listLocalProviders(
  storageDir?: string,
): Promise<ProviderResponse[]> {
  return listLocalProviderRecords(storageDir).map(providerResponse);
}

export function getLocalProviderRecordByName(
  providerName: string,
  storageDir?: string,
): LocalProviderRecord | null {
  return readAuthFile(storageDir).providers[providerName] ?? null;
}

export function getLocalProviderRecordByType(
  providerType: string,
  storageDir?: string,
): LocalProviderRecord | null {
  return (
    listLocalProviderRecords(storageDir).find(
      (provider) => provider.provider_type === providerType,
    ) ?? null
  );
}

export async function getLocalProviderByName(
  providerName: string,
  storageDir?: string,
): Promise<ProviderResponse | null> {
  const record = getLocalProviderRecordByName(providerName, storageDir);
  return record ? providerResponse(record) : null;
}

export async function createOrUpdateLocalProvider(input: {
  providerType: string;
  providerName: string;
  apiKey: string;
  accessKey?: string;
  region?: string;
  profile?: string;
  storageDir?: string;
}): Promise<ProviderResponse> {
  if (!isLocalProviderTypeSupported(input.providerType)) {
    throw new Error(
      `Provider type "${input.providerType}" is not supported in local mode yet.`,
    );
  }

  const file = readAuthFile(input.storageDir);
  const existing = file.providers[input.providerName];
  const now = new Date().toISOString();
  const auth: LocalProviderAuth =
    input.providerType === "chatgpt_oauth"
      ? parseChatGPTOAuth(input.apiKey)
      : { type: "api", key: input.apiKey };
  const next: LocalProviderRecord = {
    id: existing?.id ?? providerId(input.providerName),
    name: input.providerName,
    provider_type: input.providerType,
    provider_category: "byok",
    auth,
    ...(input.accessKey ? { access_key: input.accessKey } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  file.providers[input.providerName] = next;
  writeAuthFile(file, input.storageDir);
  return providerResponse(next);
}

export async function updateLocalProvider(
  providerIdValue: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  storageDir?: string,
): Promise<ProviderResponse> {
  const existing = listLocalProviderRecords(storageDir).find(
    (provider) => provider.id === providerIdValue,
  );
  if (!existing) {
    throw new Error(`Local provider "${providerIdValue}" not found.`);
  }
  return createOrUpdateLocalProvider({
    providerType: existing.provider_type,
    providerName: existing.name,
    apiKey,
    accessKey,
    region,
    profile,
    storageDir,
  });
}

export async function deleteLocalProvider(
  providerIdValue: string,
  storageDir?: string,
): Promise<void> {
  const file = readAuthFile(storageDir);
  const provider = Object.values(file.providers).find(
    (record) => record.id === providerIdValue,
  );
  if (!provider) return;
  delete file.providers[provider.name];
  writeAuthFile(file, storageDir);
}

export async function removeLocalProviderByName(
  providerName: string,
  storageDir?: string,
): Promise<void> {
  const file = readAuthFile(storageDir);
  if (!(providerName in file.providers)) return;
  delete file.providers[providerName];
  writeAuthFile(file, storageDir);
}

export function getLocalProviderApiKeyByName(
  providerName: string,
  storageDir?: string,
): string | undefined {
  const record = getLocalProviderRecordByName(providerName, storageDir);
  return record?.auth.type === "api" ? record.auth.key : undefined;
}

export function getLocalProviderApiKeyByType(
  providerType: string,
  storageDir?: string,
): string | undefined {
  const record = getLocalProviderRecordByType(providerType, storageDir);
  return record?.auth.type === "api" ? record.auth.key : undefined;
}

export function getLocalChatGPTOAuth(
  storageDir?: string,
): LocalProviderOAuthAuth | undefined {
  const record = getLocalProviderRecordByName(
    LOCAL_CHATGPT_PROVIDER_NAME,
    storageDir,
  );
  return record?.auth.type === "oauth" ? record.auth : undefined;
}

export function setLocalChatGPTOAuth(
  auth: LocalProviderOAuthAuth,
  storageDir?: string,
): void {
  const file = readAuthFile(storageDir);
  const now = new Date().toISOString();
  const existing = file.providers[LOCAL_CHATGPT_PROVIDER_NAME];
  file.providers[LOCAL_CHATGPT_PROVIDER_NAME] = {
    id: existing?.id ?? providerId(LOCAL_CHATGPT_PROVIDER_NAME),
    name: LOCAL_CHATGPT_PROVIDER_NAME,
    provider_type: "chatgpt_oauth",
    provider_category: "byok",
    auth,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  writeAuthFile(file, storageDir);
}

function parseChatGPTOAuth(value: string): LocalProviderOAuthAuth {
  const parsed = JSON.parse(value) as {
    access_token?: unknown;
    id_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
    expires_at?: unknown;
  };
  if (typeof parsed.access_token !== "string") {
    throw new Error("ChatGPT OAuth config is missing access_token.");
  }
  if (typeof parsed.expires_at !== "number") {
    throw new Error("ChatGPT OAuth config is missing expires_at.");
  }
  return {
    type: "oauth",
    access: parsed.access_token,
    expires: parsed.expires_at,
    ...(typeof parsed.refresh_token === "string"
      ? { refresh: parsed.refresh_token }
      : {}),
    ...(typeof parsed.id_token === "string"
      ? { idToken: parsed.id_token }
      : {}),
    ...(typeof parsed.account_id === "string"
      ? { accountId: parsed.account_id }
      : {}),
  };
}
