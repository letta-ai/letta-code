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

/**
 * Sidecar record for one discovered model. The published pi-ai `Model`
 * carries only the effective (post-policy) values; this record keeps the
 * provider-advertised inputs next to them so callers can tell whether a
 * value came from the endpoint or from the harness ceiling.
 */
export interface OpenAICompatibleTokenLimitRecord {
  /** Endpoint-reported `max_input_tokens`, when present and valid. */
  advertisedContextLength?: number;
  /** Endpoint-reported `max_output_tokens`, when present and valid. */
  advertisedMaxOutputTokens?: number;
  /** Context window published on the Model after the harness cap policy. */
  effectiveContextWindow: number;
  /** Output cap published on the Model after the harness policy. */
  effectiveMaxTokens: number;
}

// Provider+model keyed sidecar — deliberately module-scoped instead of new
// fields on the external pi-ai `Model` type. Each successful refresh replaces
// the provider's whole slice, so records for models the endpoint no longer
// lists disappear with it.
const openAICompatibleTokenLimits = new Map<
  string,
  Map<string, OpenAICompatibleTokenLimitRecord>
>();

/** Replaces the sidecar slice for one provider id. */
export function setOpenAICompatibleTokenLimits(
  providerId: string,
  records: ReadonlyArray<
    OpenAICompatibleTokenLimitRecord & { modelId: string }
  >,
): void {
  const slice = new Map<string, OpenAICompatibleTokenLimitRecord>();
  for (const record of records) {
    const { modelId, ...limits } = record;
    slice.set(modelId, limits);
  }
  openAICompatibleTokenLimits.set(providerId, slice);
}

/** Reads the sidecar record for one provider+model pair, when fresh. */
export function openAICompatibleTokenLimitRecord(
  providerId: string,
  modelId: string,
): OpenAICompatibleTokenLimitRecord | undefined {
  return openAICompatibleTokenLimits.get(providerId)?.get(modelId);
}

const openAICompatibleDiscover: LocalEndpointDiscover = async (context) => {
  const list = await context.fetchJson(`${context.openAIBaseURL}/models`);
  const records: Array<OpenAICompatibleTokenLimitRecord & { modelId: string }> =
    [];
  const models = openAICompatibleListEntries(list).map((entry) => {
    // Optional max_input_tokens / max_output_tokens are authoritative per
    // field; when a field is absent or malformed, fall back to the
    // last-known model value, then to the shared harness defaults.
    const previous = context.lastKnown.get(entry.id);
    const model = context.buildModel({
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
    // Effective values are read back off the built Model so the sidecar can
    // never drift from what turn requests actually use; the clamp itself
    // stays an explicit buildModel policy, not duplicated arithmetic here.
    records.push({
      modelId: entry.id,
      advertisedContextLength: entry.maxInputTokens,
      advertisedMaxOutputTokens: entry.maxOutputTokens,
      effectiveContextWindow: model.contextWindow,
      effectiveMaxTokens: model.maxTokens,
    });
    return model;
  });
  setOpenAICompatibleTokenLimits(OPENAI_COMPATIBLE_PI_PROVIDER_ID, records);
  return models;
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
