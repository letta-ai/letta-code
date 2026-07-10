import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";

// Match pi-ai's minimum non-thinking output allowance. Its separate 4k safety
// reserve can otherwise leave a nominally successful turn with one token.
const MIN_VIABLE_OUTPUT_TOKENS = 1024;

export function assertViablePiOutputBudget(
  model: Model<Api>,
  context: Context,
  requestedMaxTokens?: number,
): void {
  // The regression is proven for llama.cpp. Other providers retain their
  // existing provider-error and oversized-transport recovery semantics.
  if (model.provider !== "llama-cpp") return;
  const requested = requestedMaxTokens ?? model.maxTokens;
  if (!Number.isFinite(requested) || requested <= 0) return;

  const clamped = clampMaxTokensToContext(model, context, requested);
  const minimum = Math.min(requested, MIN_VIABLE_OUTPUT_TOKENS);
  if (clamped >= minimum) return;

  throw new Error(
    `Context window of ${model.contextWindow} tokens leaves only ${clamped} output token${clamped === 1 ? "" : "s"}; at least ${minimum} are required. Compact the conversation or increase the context window.`,
  );
}
