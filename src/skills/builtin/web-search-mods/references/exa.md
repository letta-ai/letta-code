# Exa web search mod

Create this file at `~/.letta/mods/exa-search.ts`.

It registers `exa_search`, a model-callable tool backed by the Exa Search API. It reads `EXA_API_KEY` from the environment.

```ts
const EXA_API_URL = "https://api.exa.ai/search";

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
  const date = stringArg(result?.publishedDate);
  const author = stringArg(result?.author);
  const text = stringArg(result?.text);
  const highlights = Array.isArray(result?.highlights)
    ? result.highlights.map((item) => stringArg(item)).filter(Boolean)
    : [];
  const summary = stringArg(result?.summary);

  return [
    `### ${index + 1}. ${title}`,
    url,
    date ? `Published: ${date}` : "",
    author ? `Author: ${author}` : "",
    summary ? `Summary: ${summary}` : "",
    highlights.length ? `Highlights:\n${highlights.map((item) => `- ${item}`).join("\n")}` : "",
    text ? `Text:\n${text.slice(0, 1600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export default function activate(letta) {
  if (!letta.capabilities.tools) return;

  return letta.tools.register({
    name: "exa_search",
    description:
      "Search the live web with Exa and return ranked results with text/highlights. Use for current facts, source discovery, research papers, companies, news, or web pages.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The web-search query.",
        },
        type: {
          type: "string",
          enum: ["auto", "instant", "fast", "deep-lite", "deep"],
          description: "Search type. Defaults to auto.",
        },
        category: {
          type: "string",
          enum: ["company", "research paper", "news", "personal site", "financial report", "people"],
          description: "Optional result category to focus the search.",
        },
        num_results: {
          type: "number",
          description: "Number of results to return, 1-10. Defaults to 5.",
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
        start_published_date: {
          type: "string",
          description: "Optional ISO date/time. Only results published after this date.",
        },
        end_published_date: {
          type: "string",
          description: "Optional ISO date/time. Only results published before this date.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    requiresApproval: false,
    parallelSafe: true,
    async run(ctx) {
      const apiKey = process.env.EXA_API_KEY;
      if (!apiKey) {
        return {
          status: "error",
          content:
            "EXA_API_KEY is not set in the Letta Code process environment. Restart Letta Code with EXA_API_KEY set.",
        };
      }

      const query = stringArg(ctx.args.query);
      if (!query) return { status: "error", content: "query is required" };

      const body = {
        query,
        type: pickEnum(
          ctx.args.type,
          ["auto", "instant", "fast", "deep-lite", "deep"],
          "auto",
        ),
        numResults: clampInteger(ctx.args.num_results, 5, 1, 10),
        contents: {
          text: { maxCharacters: 1600 },
          highlights: true,
          summary: { query: "Main relevant facts for the user's question" },
        },
        moderation: true,
      };

      const category = pickEnum(
        ctx.args.category,
        ["company", "research paper", "news", "personal site", "financial report", "people"],
        "",
      );
      if (category) body.category = category;

      const includeDomains = stringArrayArg(ctx.args.include_domains);
      if (includeDomains.length > 0) body.includeDomains = includeDomains;

      const excludeDomains = stringArrayArg(ctx.args.exclude_domains);
      if (excludeDomains.length > 0) body.excludeDomains = excludeDomains;

      const startPublishedDate = stringArg(ctx.args.start_published_date);
      if (startPublishedDate) body.startPublishedDate = startPublishedDate;

      const endPublishedDate = stringArg(ctx.args.end_published_date);
      if (endPublishedDate) body.endPublishedDate = endPublishedDate;

      const response = await fetch(EXA_API_URL, {
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
          content: `Exa API error ${response.status}: ${detail.slice(0, 2000)}`,
        };
      }

      const data = await response.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      if (results.length === 0) return "No Exa results.";

      return ["## Exa results", ...results.map(formatResult)].join("\n\n");
    },
  });
}
```
