import type { Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
  type LocalEndpointModelMetadata,
  modelIdsFromOpenAICompatibleList,
} from "./pi-local-endpoint-provider";

export const LLAMA_CPP_PI_PROVIDER_ID = "llama-cpp";

export interface LlamaCppPiProviderOptions {
  /** Base URL as configured; `/v1` is appended/stripped as needed. */
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
}

interface LlamaCppServerProps {
  vision?: boolean;
  contextLength?: number;
}

function parseLlamaCppProps(data: unknown): LlamaCppServerProps {
  if (!data || typeof data !== "object") return {};
  const record = data as {
    modalities?: unknown;
    default_generation_settings?: unknown;
  };
  const modalities =
    record.modalities && typeof record.modalities === "object"
      ? (record.modalities as { vision?: unknown })
      : undefined;
  const generationSettings =
    record.default_generation_settings &&
    typeof record.default_generation_settings === "object"
      ? (record.default_generation_settings as { n_ctx?: unknown })
      : undefined;
  const contextLength = generationSettings?.n_ctx;
  return {
    ...(typeof modalities?.vision === "boolean"
      ? { vision: modalities.vision }
      : {}),
    ...(typeof contextLength === "number" && contextLength > 0
      ? { contextLength }
      : {}),
  };
}

/**
 * Per-model metadata from the native `/models` catalog (router mode):
 * `architecture.input_modalities` and `meta.n_ctx` per entry — the same
 * contract upstream Pi's llama.cpp provider consumes. Returns undefined
 * when no entry carries per-model metadata (plain OpenAI id list), so
 * discovery falls back to `/props?model=<id>`.
 */
function parseLlamaCppNativeModels(
  data: unknown,
): Map<string, LocalEndpointModelMetadata> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const container = data as { data?: unknown; models?: unknown };
  const entries = Array.isArray(container.data)
    ? container.data
    : Array.isArray(container.models)
      ? container.models
      : undefined;
  if (!entries) return undefined;

  const parsed = new Map<string, LocalEndpointModelMetadata>();
  let sawMetadata = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      id?: unknown;
      name?: unknown;
      architecture?: unknown;
      meta?: unknown;
    };
    const id = record.id ?? record.name;
    if (typeof id !== "string" || id.length === 0) continue;
    const architecture =
      record.architecture && typeof record.architecture === "object"
        ? (record.architecture as { input_modalities?: unknown })
        : undefined;
    const modalities = Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;
    const meta =
      record.meta && typeof record.meta === "object"
        ? (record.meta as { n_ctx?: unknown })
        : undefined;
    const contextLength =
      typeof meta?.n_ctx === "number" && meta.n_ctx > 0
        ? meta.n_ctx
        : undefined;
    if (modalities !== undefined || contextLength !== undefined) {
      sawMetadata = true;
    }
    parsed.set(id, {
      id,
      ...(modalities !== undefined
        ? { vision: modalities.includes("image") }
        : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
    });
  }
  return sawMetadata ? parsed : undefined;
}

/**
 * llama.cpp capability discovery with per-model metadata. Preference order:
 *
 * 1. Native `/models` catalog entries (`architecture.input_modalities`,
 *    `meta.n_ctx`) — authoritative per model, including router mode where
 *    one server hosts many models.
 * 2. `GET /props?model=<id>` per model. Single-model servers ignore the
 *    query parameter and return their global props, which is correct there;
 *    router servers return the addressed model's props.
 * 3. The model's last-known published Model, else text-only — one model's
 *    metadata is never applied to another, and capabilities are never
 *    guessed from the model name.
 */
const llamaCppDiscover: LocalEndpointDiscover = async (context) => {
  const list = await context.fetchJson(`${context.openAIBaseURL}/models`);
  const native = parseLlamaCppNativeModels(list);
  if (native) {
    return [...native.values()].map(context.buildModel);
  }

  const modelIds = modelIdsFromOpenAICompatibleList(list);
  return Promise.all(
    modelIds.map(async (modelId) => {
      try {
        const props = parseLlamaCppProps(
          await context.fetchJson(
            `${context.nativeBaseURL}/props?model=${encodeURIComponent(modelId)}`,
          ),
        );
        return context.buildModel({
          id: modelId,
          ...(props.vision !== undefined ? { vision: props.vision } : {}),
          ...(props.contextLength
            ? { contextLength: props.contextLength }
            : {}),
        });
      } catch {
        return (
          context.lastKnown.get(modelId) ?? context.buildModel({ id: modelId })
        );
      }
    }),
  );
};

/**
 * Real dynamic pi-ai Provider for a llama.cpp server. Replaces the Letta
 * connector that fabricated Models from name substrings; mirrors upstream
 * Pi's first-class llama.cpp provider design (per-model engine metadata
 * owns capabilities). See `createLocalEndpointPiProvider` for shared
 * refresh/auth semantics.
 */
export function createLlamaCppPiProvider(
  options: LlamaCppPiProviderOptions,
): Provider<"openai-completions"> {
  return createLocalEndpointPiProvider({
    id: LLAMA_CPP_PI_PROVIDER_ID,
    name: "llama.cpp",
    baseURL: options.baseURL,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.discoveryTimeoutMs
      ? { discoveryTimeoutMs: options.discoveryTimeoutMs }
      : {}),
    discover: llamaCppDiscover,
  });
}
