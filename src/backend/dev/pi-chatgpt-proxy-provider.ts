import type { Model, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { clampThinkingLevel, createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export interface ChatGPTResponsesProxyRoute {
  baseURL: string;
  providerAlias: string;
}

function normalizeProxyBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

function proxyOAuthAuth(upstream: Provider): Provider["auth"] {
  const oauth = upstream.auth.oauth;
  if (!oauth) {
    throw new Error("OpenAI Codex provider is missing OAuth support");
  }

  return {
    ...upstream.auth,
    oauth: {
      ...oauth,
      toAuth: async (credential) => {
        const auth = await oauth.toAuth(credential);
        const accountId =
          typeof credential.accountId === "string" && credential.accountId
            ? credential.accountId
            : undefined;

        return {
          ...auth,
          ...(accountId
            ? {
                headers: {
                  ...auth.headers,
                  "chatgpt-account-id": accountId,
                },
              }
            : {}),
        };
      },
    },
  };
}

function proxyResponsesStreams(
  responses: ProviderStreams = openAIResponsesApi(),
): ProviderStreams {
  return {
    stream: responses.stream,
    streamSimple: (model, context, options) => {
      // Aperture accepts standard Responses JSON but rejects
      // max_output_tokens. Calling the raw stream avoids streamSimple's
      // fallback to model.maxTokens while retaining the other common options.
      const rawOptions: Record<string, unknown> = { ...options };
      delete rawOptions.maxTokens;
      delete rawOptions.reasoning;
      delete rawOptions.thinkingBudgets;

      if (options?.reasoning) {
        const reasoning = clampThinkingLevel(model, options.reasoning);
        if (reasoning !== "off") {
          rawOptions.reasoningEffort = reasoning;
        }
      }

      return responses.stream(
        model,
        context,
        rawOptions as Parameters<ProviderStreams["stream"]>[2],
      );
    },
  };
}

export function createChatGPTResponsesProxyProvider(options: {
  upstream: Provider;
  route: ChatGPTResponsesProxyRoute;
  responses?: ProviderStreams;
}): Provider<"openai-responses"> {
  const { upstream, route } = options;
  if (upstream.id !== OPENAI_CODEX_PROVIDER_ID) {
    throw new Error(`Unexpected ChatGPT proxy provider: ${upstream.id}`);
  }

  const baseURL = normalizeProxyBaseURL(route.baseURL);
  const models = upstream.getModels().map(
    (model): Model<"openai-responses"> => ({
      ...model,
      api: "openai-responses",
      baseUrl: baseURL,
      headers: {
        ...model.headers,
        "X-Letta-Provider-Alias": route.providerAlias,
      },
    }),
  );

  return createProvider<"openai-responses">({
    id: upstream.id,
    name: upstream.name,
    baseUrl: baseURL,
    headers: {
      ...upstream.headers,
      "X-Letta-Provider-Alias": route.providerAlias,
    },
    auth: proxyOAuthAuth(upstream),
    models,
    api: proxyResponsesStreams(options.responses),
  });
}
