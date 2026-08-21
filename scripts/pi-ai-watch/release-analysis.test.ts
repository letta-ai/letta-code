import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areAdjacentStableReleases,
  compareStableVersions,
  extractChangelogSection,
  findNextStableRelease,
  type PackageRelease,
  parseRegistryMetadata,
  readInstalledVersion,
} from "./release-analysis.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pi-ai npm releases", () => {
  test("filters prereleases and orders stable versions semantically", () => {
    const releases = parseRegistryMetadata({
      versions: {
        "0.10.0": {
          version: "0.10.0",
          gitHead: "new",
          dist: { integrity: "sha-new", tarball: "https://example/new.tgz" },
        },
        "0.9.1-beta.0": { version: "0.9.1-beta.0" },
        "0.9.2": { version: "0.9.2" },
      },
      time: {
        "0.10.0": "2026-01-03T00:00:00Z",
        "0.9.1-beta.0": "2026-01-01T00:00:00Z",
        "0.9.2": "2026-01-02T00:00:00Z",
      },
    });

    expect(releases.map((release) => release.version)).toEqual([
      "0.9.2",
      "0.10.0",
    ]);
    expect(releases[1]).toMatchObject({
      integrity: "sha-new",
      tarball_url: "https://example/new.tgz",
      git_head: "new",
    });
  });

  test("rejects stable releases without publication times", () => {
    expect(() =>
      parseRegistryMetadata({
        versions: { "0.82.1": { version: "0.82.1" } },
        time: {},
      }),
    ).toThrow("missing publication time for 0.82.1");
  });

  test("selects exactly the next stable version after the cursor", () => {
    const releases = releaseList("0.82.1", "0.83.0", "0.84.0");
    expect(findNextStableRelease(releases, "0.82.1")?.version).toBe("0.83.0");
    expect(findNextStableRelease(releases, "0.84.0")).toBeNull();
    expect(() => findNextStableRelease(releases, "0.80.0")).toThrow(
      "Could not find pi-ai cursor release 0.80.0",
    );
  });

  test("recognizes only adjacent release pairs", () => {
    const releases = releaseList("0.82.1", "0.83.0", "0.84.0");
    expect(areAdjacentStableReleases(releases, "0.82.1", "0.83.0")).toBe(true);
    expect(areAdjacentStableReleases(releases, "0.82.1", "0.84.0")).toBe(false);
  });
});

describe("pi-ai release evidence", () => {
  test("extracts only the requested changelog section", () => {
    const changelog = `# Changelog

## [0.84.0] - 2026-08-06

### Added

- Current feature.

## [0.83.0] - 2026-07-29

- Previous feature.
`;
    expect(
      extractChangelogSection(changelog, "0.84.0"),
    ).toBe(`## [0.84.0] - 2026-08-06

### Added

- Current feature.`);
    expect(() => extractChangelogSection(changelog, "0.82.1")).toThrow(
      "Could not find pi-ai changelog section 0.82.1",
    );
  });

  test("reads the exact resolved version from bun.lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-ai-watch-test-"));
    temporaryDirectories.push(directory);
    const lockfile = join(directory, "bun.lock");
    writeFileSync(
      lockfile,
      `{
  "workspaces": {
    "": { "dependencies": { "@earendil-works/pi-ai": "^0.82.0" } }
  },
  "packages": {
    "@earendil-works/pi-ai": ["@earendil-works/pi-ai@0.82.1", ""]
  }
}`,
    );
    expect(readInstalledVersion(lockfile)).toBe("0.82.1");
  });

  test("compares multi-digit semantic version components", () => {
    expect(compareStableVersions("0.9.9", "0.10.0")).toBeLessThan(0);
    expect(compareStableVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareStableVersions("0.84.2", "0.84.2")).toBe(0);
  });
});

function releaseList(...versions: string[]): PackageRelease[] {
  return versions.map((version, index) => ({
    version,
    published_at: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    integrity: null,
    tarball_url: null,
    git_head: null,
  }));
}
