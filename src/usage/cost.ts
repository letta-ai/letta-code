import { type Api, calculateCost, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const catalog = builtinModels();
const providerAliases: Readonly<Record<string, string>> = {
  google_ai: "google",
  "google-ai": "google",
  google_vertex: "google-vertex",
  bedrock: "amazon-bedrock",
  "openai-responses": "openai",
  "chatgpt-plus-pro": "openai-codex",
  chatgpt_oauth: "openai-codex",
  moonshot: "moonshotai",
  "kimi-code": "kimi-coding",
  moonshot_coding: "kimi-coding",
  "zai-coding": "zai",
  azure: "azure-openai-responses",
  zai_coding: "zai",
  "llama.cpp": "llama-cpp",
};

export type CostModel = string | Model<Api> | undefined | null;

/** Resolve exact catalog IDs only; never guess prices from a model-name prefix. */
export function resolveCostModel(handle: string): Model<Api> | undefined {
  const slash = handle.indexOf("/");
  if (slash < 1) return undefined;
  const provider = handle.slice(0, slash);
  return catalog.getModel(
    providerAliases[provider] ?? provider,
    handle.slice(slash + 1),
  );
}

export interface CostUsage {
  /** Uncached input tokens; cache counts are separate, as in pi-ai Usage. */
  input: number;
  /** Includes reasoning tokens unless reasoningSeparate is supplied. */
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  /** Additional reasoning tokens billed at the output rate. */
  reasoningSeparate?: number;
}

/** Client list-price estimate, including pi-ai context tiers and cache retention. */
export function calculateUsageCost(
  model: CostModel,
  usage: CostUsage,
): number | null {
  const rawProvider =
    typeof model === "string" ? model.split("/")[0] : model?.provider;
  const provider = rawProvider
    ? (providerAliases[rawProvider] ?? rawProvider)
    : undefined;
  if (provider && ["ollama", "lmstudio", "llama-cpp"].includes(provider))
    return 0;
  const resolved = typeof model === "string" ? resolveCostModel(model) : model;
  if (!resolved) return null;
  if (
    ![resolved.cost, ...(resolved.cost.tiers ?? [])].some((rates) =>
      [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some(
        (rate) => rate > 0,
      ),
    )
  )
    return null;
  const counts = [
    usage.input,
    usage.output,
    usage.cacheRead ?? 0,
    usage.cacheWrite ?? 0,
    usage.cacheWrite1h ?? 0,
    usage.reasoningSeparate ?? 0,
  ];
  if (
    counts.some((count) => !Number.isFinite(count) || count < 0) ||
    (usage.cacheWrite1h ?? 0) > (usage.cacheWrite ?? 0)
  )
    return null;
  const cost = calculateCost(resolved, {
    input: usage.input,
    output: usage.output + (usage.reasoningSeparate ?? 0),
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cacheWrite1h: usage.cacheWrite1h,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** Replace server-reported cost before raw stream consumers (including budgets) see it. */
export function priceUsageEvent<T extends { message_type?: string }>(
  event: T,
  model: CostModel,
): T & { cost_usd?: number | null } {
  if (event.message_type !== "usage_statistics") return event;
  const fields = event as Record<string, unknown>;
  const count = (key: string, fallback = 0): number =>
    fields[key] == null
      ? fallback
      : typeof fields[key] === "number"
        ? fields[key]
        : Number.NaN;
  const prompt = count("prompt_tokens", Number.NaN);
  const output = count("completion_tokens", Number.NaN);
  const cacheRead = count("cached_input_tokens");
  const cacheWrite = count("cache_write_tokens");
  // API usage can include cache tokens in prompt_tokens; local pi-ai chunks
  // keep them separate. total_tokens disambiguates without guessing by provider.
  const total = count("total_tokens", Number.NaN);
  const cached = cacheRead + cacheWrite;
  let input = prompt;
  if (cached > 0) {
    if (total === prompt + output) input -= cached;
    else if (total !== prompt + output + cached) input = Number.NaN;
  }
  return {
    ...event,
    cost_usd: calculateUsageCost(model, {
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheWrite1h: count("cache_write_1h_tokens"),
    }),
  };
}
