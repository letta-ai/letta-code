import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PI_AI_PACKAGE = "@earendil-works/pi-ai";
export const PI_AI_REPO = "earendil-works/pi";
export const DEFAULT_TARGET_REPO =
  process.env.GITHUB_REPOSITORY || "letta-ai/letta-code";

interface RegistryVersion {
  version: string;
  gitHead?: string;
  dist?: {
    integrity?: string;
    tarball?: string;
  };
}

interface RegistryMetadata {
  versions?: Record<string, RegistryVersion>;
  time?: Record<string, string>;
}

export interface PackageRelease {
  version: string;
  published_at: string;
  integrity: string | null;
  tarball_url: string | null;
  git_head: string | null;
}

export interface AnalyzePiAiReleaseOptions {
  previousVersion: string | null;
  currentVersion: string | null;
  installedVersion?: string;
  stableReleases?: PackageRelease[];
}

export interface PiAiWatchAnalysis {
  package: typeof PI_AI_PACKAGE;
  installed_version: string;
  previous_version: string;
  current_version: string;
  is_adjacent_release: boolean;
  published_at: string;
  integrity: string | null;
  tarball_url: string | null;
  git_head: string | null;
  release_url: string;
  compare_url: string;
  changelog_md: string;
  changed_files: string[];
  diff_stat: string;
  package_json_diff: string | null;
  workflow_run_url: string;
}

export async function analyzePiAiRelease(
  options: AnalyzePiAiReleaseOptions,
): Promise<PiAiWatchAnalysis> {
  const releases = options.stableReleases ?? (await listStableReleases());
  if (releases.length === 0) throw new Error("No stable pi-ai releases found");

  const current = options.currentVersion
    ? releases.find((release) => release.version === options.currentVersion)
    : releases.at(-1);
  if (!current) {
    throw new Error(
      `Could not find current pi-ai release ${options.currentVersion}`,
    );
  }

  const previous = options.previousVersion
    ? releases.find((release) => release.version === options.previousVersion)
    : findPreviousStableRelease(releases, current.version);
  if (!previous) {
    throw new Error(
      `Could not find previous pi-ai release before ${current.version}`,
    );
  }

  const installedVersion = options.installedVersion ?? readInstalledVersion();
  const previousTag = `v${previous.version}`;
  const currentTag = `v${current.version}`;
  const temp = mkdtempSync(join(tmpdir(), "pi-ai-watch-"));
  try {
    const repoDir = clonePi(temp);
    fetchTag(repoDir, previousTag);
    fetchTag(repoDir, currentTag);
    verifyTagMatchesPackage(repoDir, previousTag, previous);
    verifyTagMatchesPackage(repoDir, currentTag, current);
    const changelog = showFile(repoDir, currentTag, "packages/ai/CHANGELOG.md");
    if (changelog === null) {
      throw new Error(`packages/ai/CHANGELOG.md is missing at ${currentTag}`);
    }

    return {
      package: PI_AI_PACKAGE,
      installed_version: installedVersion,
      previous_version: previous.version,
      current_version: current.version,
      is_adjacent_release: areAdjacentStableReleases(
        releases,
        previous.version,
        current.version,
      ),
      published_at: current.published_at,
      integrity: current.integrity,
      tarball_url: current.tarball_url,
      git_head: current.git_head,
      release_url: `https://github.com/${PI_AI_REPO}/releases/tag/${currentTag}`,
      compare_url: `https://github.com/${PI_AI_REPO}/compare/${previousTag}...${currentTag}`,
      changelog_md: extractChangelogSection(changelog, current.version),
      changed_files: changedFiles(repoDir, previousTag, currentTag),
      diff_stat: diffStat(repoDir, previousTag, currentTag),
      package_json_diff: diffPreview(
        repoDir,
        previousTag,
        currentTag,
        "packages/ai/package.json",
      ),
      workflow_run_url: workflowRunUrl(),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function listStableReleases(): Promise<PackageRelease[]> {
  const response = await fetch(
    "https://registry.npmjs.org/@earendil-works%2Fpi-ai",
  );
  if (!response.ok) {
    throw new Error(
      `npm registry request failed (${response.status}): ${await response.text()}`,
    );
  }
  return parseRegistryMetadata((await response.json()) as RegistryMetadata);
}

export function parseRegistryMetadata(
  metadata: RegistryMetadata,
): PackageRelease[] {
  if (!metadata.versions || !metadata.time) {
    throw new Error(
      "pi-ai npm metadata is missing versions or publication times",
    );
  }

  return Object.entries(metadata.versions)
    .filter(([version]) => isStableVersion(version))
    .map(([version, details]) => {
      const publishedAt = metadata.time?.[version];
      if (!publishedAt) {
        throw new Error(
          `pi-ai npm metadata is missing publication time for ${version}`,
        );
      }
      return {
        version,
        published_at: publishedAt,
        integrity: details.dist?.integrity ?? null,
        tarball_url: details.dist?.tarball ?? null,
        git_head: details.gitHead ?? null,
      };
    })
    .sort((left, right) => compareStableVersions(left.version, right.version));
}

export function readInstalledVersion(lockfilePath = "bun.lock"): string {
  const lockfile = readFileSync(lockfilePath, "utf8");
  const escapedPackage = escapeRegExp(PI_AI_PACKAGE);
  const match = new RegExp(
    `"${escapedPackage}": \\["${escapedPackage}@(\\d+\\.\\d+\\.\\d+)"`,
  ).exec(lockfile);
  if (!match?.[1]) {
    throw new Error(
      `Could not parse resolved ${PI_AI_PACKAGE} version from ${lockfilePath}`,
    );
  }
  return match[1];
}

export function findNextStableRelease(
  releases: PackageRelease[],
  cursorVersion: string,
): PackageRelease | null {
  const index = releases.findIndex(
    (release) => release.version === cursorVersion,
  );
  if (index < 0) {
    throw new Error(`Could not find pi-ai cursor release ${cursorVersion}`);
  }
  return releases[index + 1] ?? null;
}

export function areAdjacentStableReleases(
  releases: PackageRelease[],
  previousVersion: string,
  currentVersion: string,
): boolean {
  return (
    findPreviousStableRelease(releases, currentVersion)?.version ===
    previousVersion
  );
}

export function extractChangelogSection(
  changelog: string,
  version: string,
): string {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\].*$`, "m");
  const match = heading.exec(changelog);
  if (!match)
    throw new Error(`Could not find pi-ai changelog section ${version}`);
  const start = match.index;
  const remaining = changelog.slice(start + match[0].length);
  const next = /^## \[/m.exec(remaining);
  const end = next ? start + match[0].length + next.index : changelog.length;
  return changelog.slice(start, end).trim();
}

function findPreviousStableRelease(
  releases: PackageRelease[],
  currentVersion: string,
): PackageRelease | null {
  const index = releases.findIndex(
    (release) => release.version === currentVersion,
  );
  if (index <= 0) return null;
  return releases[index - 1] ?? null;
}

export function compareStableVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid stable pi-ai version ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function clonePi(temp: string): string {
  const directory = join(temp, "pi");
  git([
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    `https://github.com/${PI_AI_REPO}.git`,
    directory,
  ]);
  return directory;
}

function fetchTag(repoDir: string, tag: string): void {
  git(
    [
      "fetch",
      "--filter=blob:none",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
    ],
    repoDir,
  );
}

function verifyTagMatchesPackage(
  repoDir: string,
  tag: string,
  release: PackageRelease,
): void {
  if (!release.git_head) return;
  const tagCommit = git(["rev-list", "-n", "1", tag], repoDir).trim();
  if (tagCommit !== release.git_head) {
    throw new Error(
      `pi-ai npm ${release.version} gitHead ${release.git_head} does not match ${tag} commit ${tagCommit}`,
    );
  }
}

function showFile(repoDir: string, tag: string, path: string): string | null {
  const result = spawnSync("git", ["show", `${tag}:${path}`], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout : null;
}

function changedFiles(
  repoDir: string,
  previousTag: string,
  currentTag: string,
): string[] {
  return git(
    [
      "diff",
      "--name-only",
      `${previousTag}..${currentTag}`,
      "--",
      "packages/ai",
    ],
    repoDir,
  )
    .split("\n")
    .filter(Boolean);
}

function diffStat(
  repoDir: string,
  previousTag: string,
  currentTag: string,
): string {
  return git(
    ["diff", "--stat", `${previousTag}..${currentTag}`, "--", "packages/ai"],
    repoDir,
  ).trim();
}

function diffPreview(
  repoDir: string,
  previousTag: string,
  currentTag: string,
  path: string,
): string | null {
  const output = git(
    ["diff", "--unified=3", `${previousTag}..${currentTag}`, "--", path],
    repoDir,
  );
  return output.trim() ? output.split("\n").slice(0, 160).join("\n") : null;
}

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function workflowRunUrl(): string {
  if (
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
  ) {
    return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  }
  return "local dry-run";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
