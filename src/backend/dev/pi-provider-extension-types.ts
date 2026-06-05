import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/oauth";

export type PiProviderInputType = "text" | "image";

export interface PiProviderModelRegistration {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: PiProviderInputType[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
}

export interface PiProviderConnection {
  id: string;
  providerName: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface PiProviderConnectField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

export interface PiProviderConnectConfig {
  fields?: PiProviderConnectField[];
}

export interface PiProviderOAuthDeviceCodeInfo {
  verificationUri: string;
  userCode: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

export interface PiProviderOAuthLoginCallbacks
  extends Omit<OAuthLoginCallbacks, "onDeviceCode"> {
  onDeviceCode?: (info: PiProviderOAuthDeviceCodeInfo) => void;
}

export interface PiProviderOAuthConfig {
  name?: string;
  login: (
    callbacks: PiProviderOAuthLoginCallbacks,
  ) => Promise<OAuthCredentials>;
  refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
  getApiKey: (credentials: OAuthCredentials) => string;
  modifyModels?: (
    models: Model<Api>[],
    credentials: OAuthCredentials,
  ) => Model<Api>[];
}

export interface PiProviderRegistration {
  name?: string;
  description?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: PiProviderModelRegistration[];
  listModels?: (
    connection: PiProviderConnection,
  ) => Promise<PiProviderModelRegistration[]> | PiProviderModelRegistration[];
  connect?: boolean | PiProviderConnectConfig;
  oauth?: PiProviderOAuthConfig;
}

export interface RegisteredPiProvider {
  providerName: string;
  config: PiProviderRegistration;
  ownerId?: string;
  path?: string;
}
