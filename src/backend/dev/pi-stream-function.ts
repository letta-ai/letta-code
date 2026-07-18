import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

export type PiStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export function defaultPiStream(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
) {
  if (model.api === "bedrock-converse-stream") {
    return stream(model, context, options);
  }

  if (model.api === "openai-responses" && model.provider === "openai-codex") {
    // OpenAI-compatible Codex proxies reject max_output_tokens. streamSimple
    // always derives that field from model.maxTokens, even when the caller did
    // not provide a cap. Call the Responses transport directly instead.
    const { reasoning, ...rest } = options ?? {};

    return stream(model, context, {
      ...rest,
      ...(typeof reasoning === "string" ? { reasoningEffort: reasoning } : {}),
    });
  }

  return streamSimple(model, context, options);
}
