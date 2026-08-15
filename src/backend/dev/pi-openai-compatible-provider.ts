import type { Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
  modelIdsFromOpenAICompatibleList,
} from "./pi-local-endpoint-provider";
import { OPENAI_COMPATIBLE_PI_PROVIDER_ID } from "./pi-provider-registry";

export interface OpenAICompatiblePiProviderOptions {
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
}

const openAICompatibleDiscover: LocalEndpointDiscover = async (context) => {
  const list = await context.fetchJson(`${context.openAIBaseURL}/models`);
  return modelIdsFromOpenAICompatibleList(list).map(
    (modelId) =>
      context.lastKnown.get(modelId) ?? context.buildModel({ id: modelId }),
  );
};

/**
 * Dynamic provider for an arbitrary OpenAI-compatible Chat Completions API.
 * The endpoint's /v1/models response owns model identity; capabilities remain
 * conservative because the OpenAI model-list schema does not report them.
 */
export function createOpenAICompatiblePiProvider(
  options: OpenAICompatiblePiProviderOptions,
): Provider<"openai-completions"> {
  return createLocalEndpointPiProvider({
    id: OPENAI_COMPATIBLE_PI_PROVIDER_ID,
    name: "OpenAI-compatible API",
    baseURL: options.baseURL,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.discoveryTimeoutMs
      ? { discoveryTimeoutMs: options.discoveryTimeoutMs }
      : {}),
    discover: openAICompatibleDiscover,
  });
}
