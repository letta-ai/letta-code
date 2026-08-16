import type { Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
  openAICompatibleListEntries,
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
  return openAICompatibleListEntries(list).map((entry) => {
    // Optional max_input_tokens / max_output_tokens are authoritative per
    // field; when a field is absent or malformed, fall back to the
    // last-known model value, then to the shared harness defaults.
    const previous = context.lastKnown.get(entry.id);
    return context.buildModel({
      id: entry.id,
      ...(entry.maxInputTokens !== undefined
        ? { contextLength: entry.maxInputTokens }
        : previous
          ? { contextLength: previous.contextWindow }
          : {}),
      ...(entry.maxOutputTokens !== undefined
        ? { maxTokens: entry.maxOutputTokens }
        : previous
          ? { maxTokens: previous.maxTokens }
          : {}),
    });
  });
};

/**
 * Dynamic provider for an arbitrary OpenAI-compatible Chat Completions API.
 * The endpoint's /v1/models response owns model identity and, when present,
 * its optional per-model limit metadata; capabilities stay conservative
 * wherever the model list does not report them.
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
