import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  extractAccountIdFromToken,
  OPENAI_OAUTH_CONFIG,
  type OpenAITokens,
} from "../../auth/openai-oauth";
import {
  getLocalChatGPTOAuth,
  type LocalProviderOAuthAuth,
  setLocalChatGPTOAuth,
} from "../local/LocalProviderAuthStore";
import {
  createLocalProviderFetch,
  type LocalProviderTimeout,
} from "../local/LocalProviderTimeout";

const OAUTH_DUMMY_KEY = "chatgpt-oauth";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const REFRESH_SKEW_MS = 60_000;

export interface ChatGPTOAuthModelFactoryOptions {
  model?: string;
  storageDir?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
  createModel?: (model: string) => LanguageModel;
}

function shouldRewriteOpenAIUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.endsWith("/v1/responses") ||
      parsed.pathname.endsWith("/responses") ||
      parsed.pathname.endsWith("/chat/completions")
    );
  } catch {
    return false;
  }
}

async function refreshAuth(
  auth: LocalProviderOAuthAuth,
  storageDir?: string,
): Promise<LocalProviderOAuthAuth> {
  if (!auth.refresh) {
    throw new Error(
      "ChatGPT OAuth token expired and no refresh token is stored.",
    );
  }

  const response = await fetch(OPENAI_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_OAUTH_CONFIG.clientId,
      refresh_token: auth.refresh,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to refresh ChatGPT OAuth token (HTTP ${response.status}): ${await response.text()}`,
    );
  }

  const tokens = (await response.json()) as OpenAITokens;
  const access = tokens.access_token;
  let accountId = auth.accountId;
  try {
    accountId = extractAccountIdFromToken(access);
  } catch {
    if (!accountId) {
      throw new Error(
        "Failed to extract ChatGPT account ID from refreshed token.",
      );
    }
  }
  const next: LocalProviderOAuthAuth = {
    type: "oauth",
    access,
    expires: Date.now() + tokens.expires_in * 1000,
    refresh: tokens.refresh_token ?? auth.refresh,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    ...(accountId ? { accountId } : {}),
  };
  setLocalChatGPTOAuth(next, storageDir);
  return next;
}

async function getFreshAuth(
  storageDir?: string,
): Promise<LocalProviderOAuthAuth> {
  const auth = getLocalChatGPTOAuth(storageDir);
  if (!auth) {
    throw new Error("ChatGPT OAuth is not connected. Run /connect chatgpt.");
  }
  if (auth.expires > Date.now() + REFRESH_SKEW_MS) return auth;
  return refreshAuth(auth, storageDir);
}

function createChatGPTFetch(options: {
  storageDir?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): typeof fetch {
  const baseFetch = createLocalProviderFetch({
    fetch: options.fetch,
    timeout: options.timeout,
  });
  return (async (input, init) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input instanceof URL ? input.toString() : input, init);
    const rewrittenUrl = shouldRewriteOpenAIUrl(request.url)
      ? CODEX_API_ENDPOINT
      : request.url;
    const next = new Request(rewrittenUrl, request);
    const auth = await getFreshAuth(options.storageDir);

    next.headers.delete("authorization");
    next.headers.set("authorization", `Bearer ${auth.access}`);
    next.headers.set("OpenAI-Beta", "responses=v1");
    next.headers.set("OpenAI-Originator", "codex");
    if (auth.accountId) {
      next.headers.set("ChatGPT-Account-Id", auth.accountId);
    }

    return baseFetch(next);
  }) as typeof fetch;
}

function createDefaultChatGPTOAuthModel(options: {
  model: string;
  storageDir?: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): LanguageModel {
  const provider = createOpenAI({
    apiKey: OAUTH_DUMMY_KEY,
    fetch: createChatGPTFetch({
      storageDir: options.storageDir,
      fetch: options.fetch,
      timeout: options.timeout,
    }),
  });
  return provider.responses(options.model);
}

export function createChatGPTOAuthModelFactory(
  options: ChatGPTOAuthModelFactoryOptions = {},
): () => LanguageModel {
  const model = options.model;
  if (!model) {
    throw new Error("No model configured for ChatGPT OAuth.");
  }
  const createModel =
    options.createModel ??
    ((model: string) =>
      createDefaultChatGPTOAuthModel({
        model,
        storageDir: options.storageDir,
        fetch: options.fetch,
        timeout: options.timeout,
      }));
  return () => createModel(model);
}
