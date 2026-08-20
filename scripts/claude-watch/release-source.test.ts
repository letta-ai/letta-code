import {
  ClaudeReleaseSourceDisagreementError,
  parseClaudeGitHubReleases,
  parseClaudeNpmMetadata,
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

  test("takes the oldest release after the terminal processed version", () => {
    const candidate = selectClaudeReleaseCandidate({
      githubReleases: releases,
      npmMetadata: npm(),
      processedPackageVersions: ["1.0.0"],
    });

    expect(candidate?.version).toBe("1.1.0");
    expect(candidate?.integrity).toBe("sha512-1.1.0");
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
    expect(candidate?.release_notes_md).toBe("notes 1.2.0");
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
});
