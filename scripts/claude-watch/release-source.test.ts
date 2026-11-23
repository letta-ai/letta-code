import {
  ClaudeReleaseSourceDisagreementError,
  fetchClaudeGitHubReleases,
  parseClaudeGitHubReleases,
  parseClaudeNpmMetadata,
  releaseNotesForRange,
  selectClaudeReleaseCandidate,
} from "./release-source.ts";
import type { ClaudeGitHubRelease, ClaudeNpmMetadata } from "./types.ts";

function github(version: string, hour: number): ClaudeGitHubRelease {
  return {
    tag_name: version,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/anthropics/claude-code/releases/tag/v${version}`,
    body: `notes ${version}`,
    published_at: `2026-08-01T${String(hour).padStart(2, "0")}:00:00Z`,
  };
}

function npm(latest = "1.2.0"): ClaudeNpmMetadata {
  return {
    dist_tags: { latest, stable: "1.1.0", next: "2.0.0-beta.1" },
    versions: ["1.0.0", "1.1.0", "1.2.0"].map((version, index) => ({
      version,
      published_at: `2026-08-01T0${index}:30:00Z`,
      integrity: `sha512-${version}`,
      tarball_url: `https://registry.npmjs.org/pkg/-/${version}.tgz`,
    })),
  };
}

const releases = [github("1.0.0", 0), github("1.1.0", 1), github("1.2.0", 2)];

describe("parseClaudeGitHubReleases", () => {
  test("filters drafts and prereleases, normalizes tags, and orders oldest first", () => {
    const parsed = parseClaudeGitHubReleases([
      { ...github("v1.2.0", 2), tag_name: "v1.2.0" },
      { ...github("1.3.0-beta.1", 3), prerelease: true },
      { ...github("1.1.0", 1), draft: true },
      { ...github("v1.0.0", 0), tag_name: "v1.0.0" },
    ]);

    expect(parsed.map(({ tag_name }) => tag_name)).toEqual(["1.0.0", "1.2.0"]);
  });
});

describe("fetchClaudeGitHubReleases", () => {
  test("resolves the latest release without fetching a list page", async () => {
    const urls: string[] = [];
    const fetched = await fetchClaudeGitHubReleases({
      previousVersion: "1.2.0",
      retries: 0,
      fetch: (async (input) => {
        urls.push(String(input));
        return Response.json(github("1.2.0", 2));
      }) as typeof fetch,
    });

    expect(fetched).toEqual([github("1.2.0", 2)]);
    expect(urls).toEqual([
      "https://api.github.com/repos/anthropics/claude-code/releases/latest",
    ]);
  });

  test("resolves an explicit release without fetching a list page", async () => {
    const urls: string[] = [];
    const fetched = await fetchClaudeGitHubReleases({
      currentVersion: "1.1.0",
      previousVersion: "1.1.0",
      retries: 0,
      fetch: (async (input) => {
        const url = String(input);
        urls.push(url);
        return Response.json(
          url.endsWith("/latest") ? github("1.2.0", 2) : github("1.1.0", 1),
        );
      }) as typeof fetch,
    });

    expect(fetched).toEqual([github("1.1.0", 1), github("1.2.0", 2)]);
    expect(urls).toEqual([
      "https://api.github.com/repos/anthropics/claude-code/releases/latest",
      "https://api.github.com/repos/anthropics/claude-code/releases/tags/v1.1.0",
    ]);
  });

  test("pages only until the previous release needed for a range", async () => {
    const urls: string[] = [];
    const filler = Array.from({ length: 100 }, (_, index) => ({
      ...github(`2.0.${index}`, 3),
      published_at: `2026-08-02T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
    }));
    const fetched = await fetchClaudeGitHubReleases({
      currentVersion: "1.2.0",
      previousVersion: "1.0.0",
      retries: 0,
      fetch: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/latest")) return Response.json(github("1.2.0", 2));
        if (url.endsWith("/tags/v1.2.0"))
          return Response.json(github("1.2.0", 2));
        if (url.endsWith("/tags/v1.0.0"))
          return Response.json(github("1.0.0", 0));
        if (url.endsWith("page=1")) return Response.json(filler);
        if (url.endsWith("page=2"))
          return Response.json([github("1.1.0", 1), github("1.0.0", 0)]);
        throw new Error(`Unexpected request ${url}`);
      }) as typeof fetch,
    });

    expect(fetched.map(({ tag_name }) => tag_name)).toContain("1.1.0");
    expect(urls.filter((url) => url.includes("?per_page=100"))).toEqual([
      "https://api.github.com/repos/anthropics/claude-code/releases?per_page=100&page=1",
      "https://api.github.com/repos/anthropics/claude-code/releases?per_page=100&page=2",
    ]);
  });

  test("keeps validation-only npm replays off list pages", async () => {
    const urls: string[] = [];
    const fetched = await fetchClaudeGitHubReleases({
      currentVersion: "1.1.0",
      previousVersion: "1.0.0",
      allowNpmOnlyExactVersions: true,
      retries: 0,
      fetch: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/latest")) return Response.json(github("1.2.0", 2));
        return new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        });
      }) as typeof fetch,
    });

    expect(fetched).toEqual([github("1.2.0", 2)]);
    expect(urls.some((url) => url.includes("?per_page=100"))).toBe(false);
  });

  test("preserves point-endpoint retry errors for a missing explicit tag", async () => {
    let requests = 0;
    const result = fetchClaudeGitHubReleases({
      currentVersion: "9.9.9",
      retries: 1,
      backoffMs: 0,
      sleep: async () => {},
      fetch: (async (input) => {
        requests++;
        if (String(input).endsWith("/latest"))
          return Response.json(github("1.2.0", 2));
        return new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        });
      }) as typeof fetch,
    });

    await expect(result).rejects.toThrow(
      "Failed to fetch https://api.github.com/repos/anthropics/claude-code/releases/tags/v9.9.9 after 2 attempts",
    );
    expect(requests).toBe(3);
  });
});

describe("parseClaudeNpmMetadata", () => {
  test("includes channels, all publish times, integrity, and tarballs", () => {
    const parsed = parseClaudeNpmMetadata({
      "dist-tags": { latest: "1.1.0", stable: "1.0.0", next: "1.2.0-beta.1" },
      versions: {
        "1.1.0": {
          dist: { integrity: "sha512-b", tarball: "https://npm/b.tgz" },
        },
        "1.0.0": {
          dist: { integrity: "sha512-a", tarball: "https://npm/a.tgz" },
        },
      },
      time: {
        "1.0.0": "2026-08-01T00:00:00Z",
        "1.1.0": "2026-08-02T00:00:00Z",
      },
    });

    expect(parsed.dist_tags).toEqual({
      latest: "1.1.0",
      stable: "1.0.0",
      next: "1.2.0-beta.1",
    });
    expect(parsed.versions).toEqual([
      {
        version: "1.0.0",
        published_at: "2026-08-01T00:00:00Z",
        integrity: "sha512-a",
        tarball_url: "https://npm/a.tgz",
      },
      {
        version: "1.1.0",
        published_at: "2026-08-02T00:00:00Z",
        integrity: "sha512-b",
        tarball_url: "https://npm/b.tgz",
      },
    ]);
  });
});

describe("selectClaudeReleaseCandidate", () => {
  test("throws an actionable typed error when latest sources mismatch", () => {
    expect(() =>
      selectClaudeReleaseCandidate({
        githubReleases: releases,
        npmMetadata: npm("1.1.0"),
        processedPackageVersions: ["1.0.0"],
      }),
    ).toThrow(ClaudeReleaseSourceDisagreementError);

    try {
      selectClaudeReleaseCandidate({
        githubReleases: releases,
        npmMetadata: npm("1.1.0"),
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "CLAUDE_RELEASE_SOURCE_DISAGREEMENT",
        githubVersion: "1.2.0",
        npmVersion: "1.1.0",
      });
      expect((error as Error).message).toContain("rerun the watcher");
    }
  });

  test("takes the latest release after the terminal processed version", () => {
    const candidate = selectClaudeReleaseCandidate({
      githubReleases: releases,
      npmMetadata: npm(),
      processedPackageVersions: ["1.0.0"],
    });

    expect(candidate?.version).toBe("1.2.0");
    expect(candidate?.integrity).toBe("sha512-1.2.0");
    expect(candidate?.release_notes_md).toContain("## [1.1.0]");
    expect(candidate?.release_notes_md).toContain("notes 1.1.0");
    expect(candidate?.release_notes_md).toContain("## [1.2.0]");
    expect(candidate?.release_notes_md).not.toContain("notes 1.0.0");
  });

  test("bootstrap selects only the current npm latest release", () => {
    const candidate = selectClaudeReleaseCandidate({
      githubReleases: releases,
      npmMetadata: npm(),
    });

    expect(candidate?.version).toBe("1.2.0");
  });

  test("explicit previous and current overrides select the exact release", () => {
    const candidate = selectClaudeReleaseCandidate({
      githubReleases: releases,
      npmMetadata: npm(),
      processedPackageVersions: ["1.0.0"],
      previousVersion: "1.0.0",
      currentVersion: "1.2.0",
    });

    expect(candidate?.version).toBe("1.2.0");
    expect(candidate?.release_notes_md).toContain("notes 1.1.0");
    expect(candidate?.release_notes_md).toContain("notes 1.2.0");
  });

  test("validation can replay exact npm versions omitted from the GitHub feed", () => {
    expect(() =>
      selectClaudeReleaseCandidate({
        githubReleases: [github("1.2.0", 2)],
        npmMetadata: npm(),
        previousVersion: "1.0.0",
        currentVersion: "1.1.0",
      }),
    ).toThrow(ClaudeReleaseSourceDisagreementError);

    const candidate = selectClaudeReleaseCandidate({
      githubReleases: [github("1.2.0", 2)],
      npmMetadata: npm(),
      previousVersion: "1.0.0",
      currentVersion: "1.1.0",
      allowNpmOnlyExactVersions: true,
    });

    expect(candidate?.version).toBe("1.1.0");
    expect(candidate?.release_url).toBe(
      "https://github.com/anthropics/claude-code/releases",
    );
    expect(candidate?.release_notes_md).toContain("validation-only npm replay");
  });

  test("returns null after the latest terminal version", () => {
    expect(
      selectClaudeReleaseCandidate({
        githubReleases: releases,
        npmMetadata: npm(),
        processedPackageVersions: ["1.0.0", "1.1.0", "1.2.0"],
      }),
    ).toBeNull();
  });

  test("rejects a reversed release-note range", () => {
    expect(() => releaseNotesForRange(releases, "1.2.0", "1.1.0")).toThrow(
      "Previous Claude release 1.2.0 must precede 1.1.0",
    );
  });
});
