import { LLAMA_CPP_PI_PROVIDER_ID } from "./pi-llama-cpp-provider";
import { LMSTUDIO_PI_PROVIDER_ID } from "./pi-lmstudio-provider";
import { OLLAMA_PI_PROVIDER_ID } from "./pi-ollama-provider";
import { OPENAI_COMPATIBLE_PI_PROVIDER_ID } from "./pi-provider-registry";

export const LETTA_REQUEST_KIND_HEADER = "x-letta-request-kind";

/** Whether a model request is an agent turn or a compaction summary. */
export type PiRequestKind = "turn" | "compaction";

// Self-hosted OpenAI-compatible endpoints, where the server (e.g. a logging
// proxy) can act on the request kind.
const REQUEST_KIND_PROVIDERS: ReadonlySet<string> = new Set([
  LLAMA_CPP_PI_PROVIDER_ID,
  LMSTUDIO_PI_PROVIDER_ID,
  OLLAMA_PI_PROVIDER_ID,
  OPENAI_COMPATIBLE_PI_PROVIDER_ID,
]);

export function resolvePiRequestHeaders(input: {
  provider: string;
  configuredHeaders: Record<string, string> | undefined;
  conversationId: string;
  requestKind: PiRequestKind;
}): Record<string, string> | undefined {
  if (REQUEST_KIND_PROVIDERS.has(input.provider)) {
    return {
      ...input.configuredHeaders,
      [LETTA_REQUEST_KIND_HEADER]: input.requestKind,
    };
  }
  if (input.provider !== "opencode-go") return input.configuredHeaders;
  return {
    ...input.configuredHeaders,
    "x-opencode-session": input.conversationId,
  };
}
