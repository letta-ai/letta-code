import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  getOAuthApiKey,
  type OAuthCredentials,
} from "@earendil-works/pi-ai/oauth";
import type { ProviderResponse } from "@/backend/api/providers";
import { getRegisteredPiProvider } from "@/backend/dev/pi-provider-mod-registry";
import {
  LOCAL_CHATGPT_PROVIDER_NAME,
  SUPPORTED_LOCAL_PROVIDER_TYPES,
} from "@/backend/dev/pi-provider-registry";
import type { LocalProviderTimeout } from "./local-provider-timeout";
import { getLocalBackendStorageDir } from "./paths";

export {
  LOCAL_ANTHROPIC_PROVIDER_NAME,
  LOCAL_BEDROCK_PROVIDER_NAME,
  LOCAL_CHATGPT_PROVIDER_NAME,
  LOCAL_GOOGLE_AI_PROVIDER_NAME,
  LOCAL_KIMI_CODE_PROVIDER_NAME,
  LOCAL_LLAMA_CPP_PROVIDER_NAME,
  LOCAL_LMSTUDIO_PROVIDER_NAME,
  LOCAL_MINIMAX_PROVIDER_NAME,
  LOCAL_MOONSHOT_PROVIDER_NAME,
  LOCAL_OLLAMA_CLOUD_PROVIDER_NAME,
  LOCAL_OLLAMA_PROVIDER_NAME,
  LOCAL_OPENAI_PROVIDER_NAME,
  LOCAL_OPENROUTER_PROVIDER_NAME,
  LOCAL_ZAI_CODING_PROVIDER_NAME,
  LOCAL_ZAI_PROVIDER_NAME,
} from "@/backend/dev/pi-provider-registry";

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
  [key: string]: unknown;
}

export type LocalProviderAuth = LocalProviderApiAuth | LocalProviderOAuthAuth;

export const LOCAL_PROVIDER_NO_API_KEY = "not-needed";

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
  timeout?: LocalProviderTimeout;
  created_at: string;
  updated_at: string;
}

interface LocalProviderAuthFile {
  version: 1;
  providers: Record<string, LocalProviderRecord>;
}

export function isLocalProviderTypeSupported(providerType: string): boolean {
  return (
    SUPPORTED_LOCAL_PROVIDER_TYPES.has(providerType) ||
    getRegisteredPiProvider(providerType) !== undefined
  );
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
    auth_type: record.auth.type,
    ...(record.base_url ? { base_url: record.base_url } : {}),
    ...(record.timeout !== undefined ? { timeout: record.timeout } : {}),
    ...(record.access_key ? { access_key: record.access_key } : {}),
    ...(record.region ? { region: record.region } : {}),
  };
}

export function localProviderApiKeyFromRecord(
  record: LocalProviderRecord | null | undefined,
): string | undefined {
  if (record?.auth.type !== "api") return undefined;
  return record.auth.key === LOCAL_PROVIDER_NO_API_KEY
    ? undefined
    : record.auth.key;
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
  baseURL?: string;
  timeout?: LocalProviderTimeout;
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
    ...((input.baseURL ?? existing?.base_url)
      ? { base_url: input.baseURL ?? existing?.base_url }
      : {}),
    ...(input.timeout !== undefined
      ? { timeout: input.timeout }
      : existing?.timeout !== undefined
        ? { timeout: existing.timeout }
        : {}),
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
  options: { baseURL?: string; timeout?: LocalProviderTimeout } = {},
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
    baseURL: options.baseURL,
    timeout: options.timeout,
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
  return localProviderApiKeyFromRecord(record);
}

export function getLocalProviderApiKeyByType(
  providerType: string,
  storageDir?: string,
): string | undefined {
  const record = getLocalProviderRecordByType(providerType, storageDir);
  return localProviderApiKeyFromRecord(record);
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
  setLocalOAuthProvider({
    providerName: LOCAL_CHATGPT_PROVIDER_NAME,
    providerType: "chatgpt_oauth",
    auth,
    storageDir,
  });
}

export function setLocalOAuthProvider(input: {
  providerName: string;
  providerType: string;
  auth: LocalProviderOAuthAuth;
  storageDir?: string;
}): void {
  if (!isLocalProviderTypeSupported(input.providerType)) {
    throw new Error(
      `Provider type "${input.providerType}" is not supported in local mode yet.`,
    );
  }

  const file = readAuthFile(input.storageDir);
  const now = new Date().toISOString();
  const existing = file.providers[input.providerName];
  file.providers[input.providerName] = {
    id: existing?.id ?? providerId(input.providerName),
    name: input.providerName,
    provider_type: input.providerType,
    provider_category: "byok",
    auth: input.auth,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  writeAuthFile(file, input.storageDir);
}

function toPiOAuthCredentials(auth: LocalProviderOAuthAuth): OAuthCredentials {
  const { type: _type, ...credentials } = auth;
  return {
    ...credentials,
    access: auth.access,
    refresh: auth.refresh ?? "",
    expires: auth.expires,
  };
}

function toLocalOAuthAuth(
  credentials: OAuthCredentials,
  previous?: LocalProviderOAuthAuth,
): LocalProviderOAuthAuth {
  const refresh = credentials.refresh || previous?.refresh;
  return {
    type: "oauth",
    access: credentials.access,
    expires: credentials.expires,
    ...(refresh ? { refresh } : {}),
    ...Object.fromEntries(
      Object.entries(credentials).filter(
        ([key, value]) =>
          !["access", "refresh", "expires"].includes(key) &&
          value !== undefined,
      ),
    ),
  };
}

function localOAuthAuthEquals(
  left: LocalProviderOAuthAuth,
  right: LocalProviderOAuthAuth,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function localOAuthAuthFromCredentials(
  credentials: OAuthCredentials,
): LocalProviderOAuthAuth {
  return toLocalOAuthAuth(credentials);
}

function localOAuthRecord(
  providerNames: readonly string[],
  storageDir?: string,
  providerTypes: readonly string[] = [],
): LocalProviderRecord | undefined {
  for (const providerName of providerNames) {
    const record = getLocalProviderRecordByName(providerName, storageDir);
    if (record?.auth.type === "oauth") return record;
  }
  for (const providerType of providerTypes) {
    const record = getLocalProviderRecordByType(providerType, storageDir);
    if (record?.auth.type === "oauth") return record;
  }
  return undefined;
}

export function getLocalOAuthCredentials(
  providerNames: readonly string[],
  storageDir?: string,
  providerTypes: readonly string[] = [],
): OAuthCredentials | undefined {
  const record = localOAuthRecord(providerNames, storageDir, providerTypes);
  return record
    ? toPiOAuthCredentials(record.auth as LocalProviderOAuthAuth)
    : undefined;
}

export async function getLocalOAuthApiKey(input: {
  providerId: string;
  providerNames: readonly string[];
  providerTypes?: readonly string[];
  storageDir?: string;
}): Promise<
  | {
      apiKey: string;
      credentials: OAuthCredentials;
    }
  | undefined
> {
  const record = localOAuthRecord(
    input.providerNames,
    input.storageDir,
    input.providerTypes,
  );
  if (!record || record.auth.type !== "oauth") return undefined;

  const result = await getOAuthApiKey(input.providerId, {
    [input.providerId]: toPiOAuthCredentials(record.auth),
  });
  if (!result) return undefined;

  const nextAuth = toLocalOAuthAuth(result.newCredentials, record.auth);
  if (!localOAuthAuthEquals(nextAuth, record.auth)) {
    setLocalOAuthProvider({
      providerName: record.name,
      providerType: record.provider_type,
      auth: nextAuth,
      storageDir: input.storageDir,
    });
  }
  return {
    apiKey: result.apiKey,
    credentials: result.newCredentials,
  };
}

export async function getLocalChatGPTApiKey(
  storageDir?: string,
): Promise<string | undefined> {
  const result = await getLocalOAuthApiKey({
    providerId: "openai-codex",
    providerNames: [LOCAL_CHATGPT_PROVIDER_NAME, "openai-codex"],
    providerTypes: ["chatgpt_oauth", "openai-codex"],
    storageDir,
  });
  return result?.apiKey;
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
