# Perplexity web search mod

Create this file at `~/.letta/mods/perplexity-search.ts`.

It registers `perplexity_search`, a model-callable tool backed by the Perplexity Sonar API. It reads `PERPLEXITY_API_KEY` from the environment.

```ts
const PERPLEXITY_API_URL = "https://api.perplexity.ai/v1/sonar";

function stringArg(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
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

function formatSearchResults(results) {
  if (!Array.isArray(results) || results.length === 0) return "";

  return [
    "## Search results",
    ...results.map((result, index) => {
      const title = stringArg(result?.title, "Untitled");
      const url = stringArg(result?.url);
      const date = stringArg(result?.date) || stringArg(result?.last_updated);
      const snippet = stringArg(result?.snippet);
      return [
        `### ${index + 1}. ${title}`,
        url,
        date ? `Date: ${date}` : "",
        snippet,
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

export default function activate(letta) {
  if (!letta.capabilities.tools) return;

  return letta.tools.register({
    name: "perplexity_search",
    description:
      "Search the live web with Perplexity Sonar and return an answer with citations. Use for current facts, news, and web-grounded research.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The web-search question or research objective.",
        },
        search_mode: {
          type: "string",
          enum: ["web", "academic", "sec"],
          description: "Search corpus to use. Defaults to web.",
        },
        recency: {
          type: "string",
          enum: ["hour", "day", "week", "month", "year"],
          description: "Optional publication recency filter.",
        },
        max_tokens: {
          type: "number",
          description: "Maximum answer tokens. Defaults to 1200.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    requiresApproval: false,
    parallelSafe: true,
    async run(ctx) {
      const apiKey = process.env.PERPLEXITY_API_KEY;
      if (!apiKey) {
        return {
          status: "error",
          content:
            "PERPLEXITY_API_KEY is not set in the Letta Code process environment. Restart Letta Code with PERPLEXITY_API_KEY set.",
        };
      }

      const query = stringArg(ctx.args.query);
      if (!query) return { status: "error", content: "query is required" };

      const body = {
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "Answer with concise, factual web-grounded information. Include citations when available.",
          },
          { role: "user", content: query },
        ],
        max_tokens: clampInteger(ctx.args.max_tokens, 1200, 100, 4000),
        search_mode: pickEnum(ctx.args.search_mode, ["web", "academic", "sec"], "web"),
        stream: false,
      };

      const recency = pickEnum(
        ctx.args.recency,
        ["hour", "day", "week", "month", "year"],
        "",
      );
      if (recency) body.search_recency_filter = recency;

      const response = await fetch(PERPLEXITY_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });

      if (!response.ok) {
        const detail = await readResponseBody(response);
        return {
          status: "error",
          content: `Perplexity API error ${response.status}: ${detail.slice(0, 2000)}`,
        };
      }

      const data = await response.json();
      const answer = stringArg(data?.choices?.[0]?.message?.content);
      const citations = Array.isArray(data?.citations) ? data.citations : [];
      const citationText = citations.length
        ? [
            "## Citations",
            ...citations.map((url, index) => `${index + 1}. ${url}`),
          ].join("\n")
        : "";
      const searchResults = formatSearchResults(data?.search_results);

      return ["## Perplexity answer", answer, citationText, searchResults]
        .filter(Boolean)
        .join("\n\n");
    },
  });
}
```
