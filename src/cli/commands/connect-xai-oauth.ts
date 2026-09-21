import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { ApiRequestError } from "@/backend/api/request";
import {
  type ByokProvider,
  checkProviderApiKey,
  createOrUpdateProvider,
  isXaiOAuthProvider,
} from "@/providers/byok-providers";
import { getErrorMessage } from "@/utils/error";
import {
  type LocalOAuthConnectCallbacks,
  type ProviderOAuthLoginResult,
  runProviderOAuthLogin,
} from "./connect-local-oauth";

const RESERVED_XAI_PROVIDER_NAME = "xai";

export interface CloudXaiOAuthConnectDeps {
  runLogin?: (
    provider: ByokProvider,
    callbacks: LocalOAuthConnectCallbacks,
  ) => Promise<ProviderOAuthLoginResult>;
  checkProviderApiKey?: typeof checkProviderApiKey;
  createOrUpdateProvider?: typeof createOrUpdateProvider;
  clearAvailableModelsCache?: typeof clearAvailableModelsCache;
}

export function serializeXaiOAuthCredential(
  credential: Pick<OAuthCredentials, "access" | "refresh" | "expires"> & {
    type?: unknown;
  },
): string {
  if (credential.type !== undefined && credential.type !== "oauth") {
    throw new Error("xAI login did not return OAuth credentials.");
  }
  const access = credential.access.trim();
  const refresh = credential.refresh.trim();
  if (!access || !refresh || !Number.isFinite(credential.expires)) {
    throw new Error(
      "xAI OAuth login did not return a refreshable credential bundle.",
    );
  }
  return JSON.stringify({
    type: "oauth",
    access,
    refresh,
    expires: credential.expires,
  });
}

export function mapCloudXaiOAuthCheckError(error: unknown): Error {
  const message = getErrorMessage(error);
  const status = error instanceof ApiRequestError ? error.status : undefined;
  const looksLikeBearerRejection =
    status === 401 ||
    /invalid api key|unauthorized|incorrect api key|authentication/i.test(
      message,
    );
  if (!looksLikeBearerRejection) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(
    `${message}\nLetta Cloud may be treating the Grok OAuth JSON bundle as a bearer token. This client requires Cloud xAI OAuth JSON support. Upgrade Cloud and reconnect.`,
  );
}

export async function runCloudXaiOAuthConnectFlow(
  provider: ByokProvider,
  callbacks: LocalOAuthConnectCallbacks,
  deps: CloudXaiOAuthConnectDeps = {},
): Promise<{ providerName: string }> {
  if (!isXaiOAuthProvider(provider)) {
    throw new Error(`${provider.displayName} is not an xAI OAuth provider.`);
  }
  if (provider.providerName === RESERVED_XAI_PROVIDER_NAME) {
    throw new Error(
      "Provider name 'xai' is reserved for hosted models. Cloud Grok OAuth must use 'lc-xai'.",
    );
  }

  const login = deps.runLogin ?? runProviderOAuthLogin;
  const check = deps.checkProviderApiKey ?? checkProviderApiKey;
  const save = deps.createOrUpdateProvider ?? createOrUpdateProvider;
  const clearCache =
    deps.clearAvailableModelsCache ?? clearAvailableModelsCache;

  const result = await login(provider, callbacks);
  const serialized = serializeXaiOAuthCredential(result.credential);

  await callbacks.onStatus(`Validating ${provider.displayName} connection...`);
  try {
    await check(
      provider.providerType,
      serialized,
      undefined,
      undefined,
      undefined,
      { target: "api" },
    );
  } catch (error) {
    throw mapCloudXaiOAuthCheckError(error);
  }

  await callbacks.onStatus(`Saving ${provider.displayName} provider...`);
  await save(
    provider.providerType,
    provider.providerName,
    serialized,
    undefined,
    undefined,
    undefined,
    {},
    { target: "api" },
  );
  clearCache();
  return { providerName: result.providerName };
}
