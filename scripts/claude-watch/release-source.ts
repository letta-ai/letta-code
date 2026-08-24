import type {
  ClaudeGitHubRelease,
  ClaudeNpmMetadata,
  ClaudeNpmVersion,
  ClaudeReleaseCandidate,
} from "./types.ts";

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/anthropics/claude-code/releases";
const NPM_METADATA_URL =
  "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code";
const EXACT_SEMVER =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface ReleaseSourceFetchOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ReleaseSelectionOptions {
  githubReleases: ClaudeGitHubRelease[];
  npmMetadata: ClaudeNpmMetadata;
  processedPackageVersions?: string[];
  previousVersion?: string | null;
  currentVersion?: string | null;
  allowNpmOnlyExactVersions?: boolean;
}

export class ClaudeReleaseSourceDisagreementError extends Error {
  readonly code = "CLAUDE_RELEASE_SOURCE_DISAGREEMENT";
  readonly githubVersion: string | null;
  readonly npmVersion: string;

  constructor(
    githubVersion: string | null,
    npmVersion: string,
    detail?: string,
  ) {
    const action =
      "Wait for the GitHub release and npm latest channel to agree, then rerun the watcher.";
    super(
      `Claude Code release sources disagree: GitHub latest is ${githubVersion ?? "missing"}, ` +
        `npm latest is ${npmVersion}.${detail ? ` ${detail}` : ""} ${action}`,
    );
    this.name = "ClaudeReleaseSourceDisagreementError";
    this.githubVersion = githubVersion;
    this.npmVersion = npmVersion;
  }
}

export function normalizeGitHubReleaseTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, context: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, context);
}

function compareTimestampsThenVersions(
  left: { published_at: string; version: string },
  right: { published_at: string; version: string },
): number {
  return (
    Date.parse(left.published_at) - Date.parse(right.published_at) ||
    left.version.localeCompare(right.version, undefined, { numeric: true })
  );
}

/** Parse, normalize, filter, de-duplicate, and chronologically order GitHub releases. */
export function parseClaudeGitHubReleases(
  input: unknown,
): ClaudeGitHubRelease[] {
  if (!Array.isArray(input))
    throw new TypeError("GitHub releases response must be an array");

  const byVersion = new Map<string, ClaudeGitHubRelease>();
  for (const [index, item] of input.entries()) {
    const raw = object(item, `GitHub release ${index}`);
    if (raw.draft === true || raw.prerelease === true) continue;
    if (typeof raw.draft !== "boolean" || typeof raw.prerelease !== "boolean") {
      throw new TypeError(`GitHub release ${index} has invalid release flags`);
    }
    const version = normalizeGitHubReleaseTag(
      string(raw.tag_name, `GitHub release ${index}.tag_name`),
    );
    if (!EXACT_SEMVER.test(version)) continue;
    const publishedAt = nullableString(
      raw.published_at,
      `GitHub release ${index}.published_at`,
    );
    if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) continue;
    const release: ClaudeGitHubRelease = {
      tag_name: version,
      draft: false,
      prerelease: false,
      html_url: string(raw.html_url, `GitHub release ${index}.html_url`),
      body: nullableString(raw.body, `GitHub release ${index}.body`),
      published_at: publishedAt,
    };
    const existing = byVersion.get(version);
    if (
      !existing ||
      Date.parse(publishedAt) < Date.parse(existing.published_at ?? publishedAt)
    ) {
      byVersion.set(version, release);
    }
  }

  return [...byVersion.values()].sort((left, right) =>
    compareTimestampsThenVersions(
      { published_at: left.published_at ?? "", version: left.tag_name },
      { published_at: right.published_at ?? "", version: right.tag_name },
    ),
  );
}

/** Parse the npm registry document into the small, stable shape used by the watcher. */
export function parseClaudeNpmMetadata(input: unknown): ClaudeNpmMetadata {
  const raw = object(input, "npm metadata response");
  const rawTags = object(raw["dist-tags"], "npm dist-tags");
  const latest = string(rawTags.latest, "npm dist-tags.latest");
  if (!EXACT_SEMVER.test(latest)) {
    throw new TypeError(
      `npm dist-tags.latest is not an exact semver: ${latest}`,
    );
  }
  const rawVersions = object(raw.versions, "npm versions");
  const rawTimes = object(raw.time, "npm publish times");
  const versions: ClaudeNpmVersion[] = [];

  for (const [version, versionValue] of Object.entries(rawVersions)) {
    const versionDocument = object(versionValue, `npm version ${version}`);
    const dist = object(versionDocument.dist, `npm version ${version}.dist`);
    const publishedAt = string(
      rawTimes[version],
      `npm publish time ${version}`,
    );
    if (Number.isNaN(Date.parse(publishedAt))) {
      throw new TypeError(
        `npm publish time ${version} is not a valid timestamp`,
      );
    }
    versions.push({
      version,
      published_at: publishedAt,
      integrity: string(
        dist.integrity,
        `npm version ${version}.dist.integrity`,
      ),
      tarball_url: string(dist.tarball, `npm version ${version}.dist.tarball`),
    });
  }
  versions.sort(compareTimestampsThenVersions);

  if (!versions.some((version) => version.version === latest)) {
    throw new TypeError(
      `npm latest version ${latest} is absent from npm versions`,
    );
  }

  return {
    dist_tags: {
      latest,
      stable: nullableString(rawTags.stable, "npm dist-tags.stable"),
      next: nullableString(rawTags.next, "npm dist-tags.next"),
    },
    versions,
  };
}

function assertSourcesAgree(
  githubReleases: ClaudeGitHubRelease[],
  npmMetadata: ClaudeNpmMetadata,
): void {
  const npmLatest = npmMetadata.dist_tags.latest;
  const githubLatest = githubReleases.at(-1)?.tag_name ?? null;
  if (githubLatest !== npmLatest) {
    throw new ClaudeReleaseSourceDisagreementError(githubLatest, npmLatest);
  }
}

/**
 * Select one release without side effects. Sources are checked before any selection,
 * so a disagreement cannot accidentally advance persisted watcher state.
 */
export function selectClaudeReleaseCandidate(
  options: ReleaseSelectionOptions,
): ClaudeReleaseCandidate | null {
  const githubReleases = [...options.githubReleases].sort((left, right) =>
    compareTimestampsThenVersions(
      { published_at: left.published_at ?? "", version: left.tag_name },
      { published_at: right.published_at ?? "", version: right.tag_name },
    ),
  );
  assertSourcesAgree(githubReleases, options.npmMetadata);

  const npmByVersion = new Map(
    options.npmMetadata.versions.map((version) => [version.version, version]),
  );
  const currentVersion = options.currentVersion ?? null;
  const terminalVersion =
    options.previousVersion ?? options.processedPackageVersions?.at(-1) ?? null;
  const allowNpmOnlyExactVersions =
    options.allowNpmOnlyExactVersions === true && currentVersion !== null;

  if (
    options.previousVersion &&
    (!npmByVersion.has(options.previousVersion) ||
      (!allowNpmOnlyExactVersions &&
        !githubReleases.some(
          ({ tag_name }) => tag_name === options.previousVersion,
        )))
  ) {
    throw new ClaudeReleaseSourceDisagreementError(
      githubReleases.at(-1)?.tag_name ?? null,
      options.npmMetadata.dist_tags.latest,
      `Explicit previous version ${options.previousVersion} is not present in both sources.`,
    );
  }

  let release: ClaudeGitHubRelease | undefined;
  if (currentVersion) {
    release = githubReleases.find(
      ({ tag_name }) => tag_name === currentVersion,
    );
    const npmVersion = npmByVersion.get(currentVersion);
    if (!npmVersion || (!release && !allowNpmOnlyExactVersions)) {
      throw new ClaudeReleaseSourceDisagreementError(
        githubReleases.at(-1)?.tag_name ?? null,
        options.npmMetadata.dist_tags.latest,
        `Explicit current version ${currentVersion} is not present in both sources.`,
      );
    }
    if (!release) {
      return {
        ...npmVersion,
        release_url: "https://github.com/anthropics/claude-code/releases",
        release_notes_md:
          `Historical validation-only npm replay for ${currentVersion}; ` +
          "this exact version is not retained in the GitHub release feed.",
        release_published_at: npmVersion.published_at,
        dist_tags: options.npmMetadata.dist_tags,
      };
    }
  } else if (!terminalVersion) {
    release = githubReleases.find(
      ({ tag_name }) => tag_name === options.npmMetadata.dist_tags.latest,
    );
  } else {
    const terminalIndex = githubReleases.findIndex(
      ({ tag_name }) => tag_name === terminalVersion,
    );
    if (terminalIndex < 0) {
      throw new ClaudeReleaseSourceDisagreementError(
        githubReleases.at(-1)?.tag_name ?? null,
        options.npmMetadata.dist_tags.latest,
        `Terminal version ${terminalVersion} is not present in GitHub releases.`,
      );
    }
    release = githubReleases[terminalIndex + 1];
  }

  if (!release) return null;
  const npmVersion = npmByVersion.get(release.tag_name);
  if (!npmVersion || !release.published_at) {
    throw new ClaudeReleaseSourceDisagreementError(
      githubReleases.at(-1)?.tag_name ?? null,
      options.npmMetadata.dist_tags.latest,
      `Selected version ${release.tag_name} is incomplete in a release source.`,
    );
  }
  return {
    ...npmVersion,
    release_url: release.html_url,
    release_notes_md: release.body ?? "",
    release_published_at: release.published_at,
    dist_tags: options.npmMetadata.dist_tags,
  };
}

async function fetchJson(
  url: string,
  options: ReleaseSourceFetchOptions,
  headers: HeadersInit,
): Promise<unknown> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const backoffMs = options.backoffMs ?? 250;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(url, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(backoffMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts`, {
    cause: lastError,
  });
}

export async function fetchClaudeGitHubReleases(
  options: ReleaseSourceFetchOptions = {},
): Promise<ClaudeGitHubRelease[]> {
  const rawReleases: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await fetchJson(
      `${GITHUB_RELEASES_URL}?per_page=100&page=${page}`,
      options,
      {
        Accept: "application/vnd.github+json",
        "User-Agent": "letta-claude-watch",
        ...(process.env.GH_TOKEN
          ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
          : {}),
      },
    );
    if (!Array.isArray(payload)) {
      throw new TypeError("GitHub releases response must be an array");
    }
    rawReleases.push(...payload);
    if (payload.length < 100) break;
  }
  return parseClaudeGitHubReleases(rawReleases);
}

export async function fetchClaudeNpmMetadata(
  options: ReleaseSourceFetchOptions = {},
): Promise<ClaudeNpmMetadata> {
  const payload = await fetchJson(NPM_METADATA_URL, options, {
    Accept: "application/json",
  });
  return parseClaudeNpmMetadata(payload);
}
