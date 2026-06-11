# Parallel web search mod

Create this file at `~/.letta/mods/parallel-search.ts`.

It registers `parallel_search`, a model-callable tool backed by the Parallel Search API. It reads `PARALLEL_API_KEY` from the environment.

```ts
const PARALLEL_SEARCH_API_URL = "https://api.parallel.ai/v1/search";

function stringArg(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function stringArrayArg(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringArg(item)).filter(Boolean);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatResult(result, index) {
  const title = stringArg(result?.title, "Untitled");
  const url = stringArg(result?.url);
  const publishDate = stringArg(result?.publish_date);
  const excerpts = Array.isArray(result?.excerpts)
    ? result.excerpts.map((item) => stringArg(item)).filter(Boolean)
    : [];

  return [
    `### ${index + 1}. ${title}`,
    url,
    publishDate ? `Published: ${publishDate}` : "",
    excerpts.length ? excerpts.map((excerpt) => `- ${excerpt}`).join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export default function activate(letta) {
  if (!letta.capabilities.tools) return;

  return letta.tools.register({
    name: "parallel_search",
    description:
      "Search the live web with Parallel and return LLM-optimized excerpts. Use for current facts, specific entities, recent events, or web data that should ground a response.",
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description:
            "Natural-language research goal. Include the key entity/topic and what you need to learn.",
        },
        search_queries: {
          type: "array",
          description:
            "2-3 diverse keyword queries, each 3-6 words. Vary entities, synonyms, and angles. Do not use sentences or site: operators.",
          items: { type: "string" },
          minItems: 2,
          maxItems: 3,
        },
        mode: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "Search mode. basic is lower latency; advanced is higher quality. Defaults to advanced.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results, 1-10. Defaults to 6.",
        },
        max_chars_total: {
          type: "number",
          description: "Maximum characters across all excerpts. Defaults to 6000.",
        },
        include_domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to restrict results to.",
        },
        exclude_domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to exclude from results.",
        },
        after_date: {
          type: "string",
          description: "Optional YYYY-MM-DD start date for filtering results.",
        },
      },
      required: ["objective", "search_queries"],
      additionalProperties: false,
    },
    requiresApproval: false,
    parallelSafe: true,
    async run(ctx) {
      const apiKey = process.env.PARALLEL_API_KEY;
      if (!apiKey) {
        return {
          status: "error",
          content: "PARALLEL_API_KEY is not set. Export it, then run /reload.",
        };
      }

      const objective = stringArg(ctx.args.objective);
      if (!objective) return { status: "error", content: "objective is required" };

      const searchQueries = stringArrayArg(ctx.args.search_queries).slice(0, 3);
      if (searchQueries.length === 0) {
        return { status: "error", content: "search_queries must include at least one query" };
      }

      const sourcePolicy = {};
      const includeDomains = stringArrayArg(ctx.args.include_domains);
      if (includeDomains.length > 0) sourcePolicy.include_domains = includeDomains;
      const excludeDomains = stringArrayArg(ctx.args.exclude_domains);
      if (excludeDomains.length > 0) sourcePolicy.exclude_domains = excludeDomains;
      const afterDate = stringArg(ctx.args.after_date);
      if (afterDate) sourcePolicy.after_date = afterDate;

      const advancedSettings = {
        max_results: clampInteger(ctx.args.max_results, 6, 1, 10),
        excerpt_settings: {
          max_chars_per_result: 1200,
        },
      };
      if (Object.keys(sourcePolicy).length > 0) {
        advancedSettings.source_policy = sourcePolicy;
      }

      const body = {
        objective,
        search_queries: searchQueries,
        mode: pickEnum(ctx.args.mode, ["basic", "advanced"], "advanced"),
        max_chars_total: clampInteger(ctx.args.max_chars_total, 6000, 1000, 12000),
        advanced_settings: advancedSettings,
      };

      const response = await fetch(PARALLEL_SEARCH_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });

      if (!response.ok) {
        const detail = await readResponseBody(response);
        return {
          status: "error",
          content: `Parallel API error ${response.status}: ${detail.slice(0, 2000)}`,
        };
      }

      const data = await response.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      if (results.length === 0) return "No Parallel results.";

      const warnings = Array.isArray(data?.warnings)
        ? data.warnings
            .map((warning) => stringArg(warning?.message))
            .filter(Boolean)
        : [];
      const warningText = warnings.length
        ? ["## Warnings", ...warnings.map((warning) => `- ${warning}`)].join("\n")
        : "";

      return ["## Parallel results", ...results.map(formatResult), warningText]
        .filter(Boolean)
        .join("\n\n");
    },
  });
}
```
