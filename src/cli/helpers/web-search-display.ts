export type WebSearchDisplayState =
  | "started"
  | "waiting"
  | "updated"
  | "completed"
  | "error";

export function isWebSearchToolName(name: string | undefined): boolean {
  return name === "web_search" || name === "WebSearch" || name === "webSearch";
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeDomainForDisplay(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

function formatWebSearchCategory(category: string): string {
  switch (category.trim().toLowerCase()) {
    case "github":
      return "GitHub";
    case "pdf":
      return "PDFs";
    case "research paper":
      return "research papers";
    case "financial report":
      return "financial reports";
    case "linkedin profile":
      return "LinkedIn profiles";
    case "personal site":
      return "personal sites";
    case "tweet":
      return "tweets";
    case "company":
      return "companies";
    case "news":
      return "news";
    case "article":
      return "articles";
    default:
      return category.trim().toLowerCase();
  }
}

export function formatWebSearchTarget(args: Record<string, unknown>): string {
  const category = firstNonEmptyString(args.category);
  const rawDomains = args.include_domains;
  const domainCandidates = Array.isArray(rawDomains)
    ? rawDomains
    : typeof rawDomains === "string"
      ? [rawDomains]
      : [];
  const domains = domainCandidates
    .filter((domain): domain is string => typeof domain === "string")
    .map(normalizeDomainForDisplay)
    .filter(Boolean);

  const displayCategory = category ? formatWebSearchCategory(category) : null;
  if (displayCategory && domains.length === 1) {
    return `${displayCategory} on ${domains[0]}`;
  }
  if (displayCategory) {
    return displayCategory;
  }
  if (domains.length === 1) {
    return domains[0] ?? "the web";
  }
  if (domains.length > 1) {
    return `${domains.length} domains`;
  }
  return "the web";
}

export function formatWebSearchArgsDisplay(
  args: Record<string, unknown>,
): string {
  const target = formatWebSearchTarget(args);
  const query = firstNonEmptyString(args.query);
  return query ? `${target} for “${query}”` : target;
}

function formatWebSearchPrefix(state: WebSearchDisplayState): string {
  if (state === "completed") {
    return "Searched";
  }
  if (state === "error") {
    return "Attempted to search";
  }
  return "Searching";
}

export function formatWebSearchProgressTitle(
  args: Record<string, unknown>,
  state: WebSearchDisplayState,
): string {
  return `${formatWebSearchPrefix(state)} ${formatWebSearchArgsDisplay(args)}`;
}
