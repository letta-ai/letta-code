import type { Provider } from "@earendil-works/pi-ai";
import {
  createLocalEndpointPiProvider,
  type LocalEndpointDiscover,
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
 * llama.cpp capability discovery: `/v1/models` lists the served model(s) and
 * the native `GET /props` reports the engine's authoritative modalities
 * (`modalities.vision`) and context size (`default_generation_settings.n_ctx`)
 * for the loaded model. llama-server serves one model per process, so the
 * props apply to every listed id. When `/props` is unavailable (older
 * server, proxy), each model falls back to its last-known published Model —
 * never to a model-name guess.
 */
const llamaCppDiscover: LocalEndpointDiscover = async (context) => {
  const list = await context.fetchJson(`${context.openAIBaseURL}/models`);
  const modelIds = modelIdsFromOpenAICompatibleList(list);

  let props: LlamaCppServerProps | undefined;
  try {
    props = parseLlamaCppProps(
      await context.fetchJson(`${context.nativeBaseURL}/props`),
    );
  } catch {
    props = undefined;
  }

  return modelIds.map((modelId) => {
    if (props) {
      return context.buildModel({
        id: modelId,
        ...(props.vision !== undefined ? { vision: props.vision } : {}),
        ...(props.contextLength ? { contextLength: props.contextLength } : {}),
      });
    }
    return (
      context.lastKnown.get(modelId) ?? context.buildModel({ id: modelId })
    );
  });
};

/**
 * Real dynamic pi-ai Provider for a llama.cpp server. Replaces the Letta
 * connector that fabricated Models from name substrings; mirrors upstream
 * Pi's first-class llama.cpp provider design (engine metadata owns
 * capabilities). See `createLocalEndpointPiProvider` for shared semantics.
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
