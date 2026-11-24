import type { KnownApi, ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export function knownApiStreams(): Partial<Record<KnownApi, ProviderStreams>> {
  return {
    "anthropic-messages": anthropicMessagesApi(),
    "azure-openai-responses": azureOpenAIResponsesApi(),
    "bedrock-converse-stream": bedrockConverseStreamApi(),
    "google-generative-ai": googleGenerativeAIApi(),
    "google-vertex": googleVertexApi(),
    "mistral-conversations": mistralConversationsApi(),
    "openai-codex-responses": openAICodexResponsesApi(),
    "openai-completions": openAICompletionsApi(),
    "openai-responses": openAIResponsesApi(),
  };
}
