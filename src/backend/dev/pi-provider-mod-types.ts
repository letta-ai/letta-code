import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/oauth";

export type PiProviderInputType = "text" | "image";

/**
 * A mod's model declaration, derived directly from pi-ai's Model type
 * (LET-10130): the provider is implied by the registration, and `api`/
 * `baseUrl` may be inherited from the provider-level config, so those
 * fields are relaxed. Everything else — capability inputs, cost, context
 * window, compat overrides — is pi-ai's own vocabulary.
 */
export type PiProviderModelRegistration = Omit<
  Model<Api>,
  "api" | "provider" | "baseUrl"
> & {
  api?: Api;
  baseUrl?: string;
};

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
