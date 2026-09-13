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
  is_latest_release: boolean;
  published_at: string;
  integrity: string | null;
  tarball_url: string | null;
  previous_git_head: string | null;
  git_head: string | null;
  previous_tag_commit: string;
  current_tag_commit: string;
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
  if (compareStableVersions(previous.version, current.version) >= 0) {
    throw new Error(
      `Previous pi-ai release ${previous.version} must precede ${current.version}`,
    );
  }

  const installedVersion = options.installedVersion ?? readInstalledVersion();
  const previousTag = `v${previous.version}`;
  const currentTag = `v${current.version}`;
  const temp = mkdtempSync(join(tmpdir(), "pi-ai-watch-"));
  try {
    const repoDir = clonePi(temp);
    const previousSource = resolveReleaseSource(repoDir, previousTag, previous);
    const currentSource = resolveReleaseSource(repoDir, currentTag, current);
    const changelog = showFile(
      repoDir,
      currentSource.sourceCommit,
      "packages/ai/CHANGELOG.md",
    );
    if (changelog === null) {
      throw new Error(`packages/ai/CHANGELOG.md is missing at ${currentTag}`);
    }

    return {
      package: PI_AI_PACKAGE,
      installed_version: installedVersion,
      previous_version: previous.version,
      current_version: current.version,
      is_latest_release: current.version === releases.at(-1)?.version,
      published_at: current.published_at,
      integrity: current.integrity,
      tarball_url: current.tarball_url,
      previous_git_head: previous.git_head,
      git_head: current.git_head,
      previous_tag_commit: previousSource.tagCommit,
      current_tag_commit: currentSource.tagCommit,
      release_url: `https://github.com/${PI_AI_REPO}/releases/tag/${currentTag}`,
      compare_url: `https://github.com/${PI_AI_REPO}/compare/${previousSource.sourceCommit}...${currentSource.sourceCommit}`,
      changelog_md: extractChangelogRange(
        changelog,
        previous.version,
        current.version,
      ),
      changed_files: changedFiles(
        repoDir,
        previousSource.sourceCommit,
        currentSource.sourceCommit,
      ),
      diff_stat: diffStat(
        repoDir,
        previousSource.sourceCommit,
        currentSource.sourceCommit,
      ),
      package_json_diff: diffPreview(
        repoDir,
        previousSource.sourceCommit,
        currentSource.sourceCommit,
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

export function findLatestStableReleaseAfter(
  releases: PackageRelease[],
  cursorVersion: string,
): PackageRelease | null {
  const index = releases.findIndex(
    (release) => release.version === cursorVersion,
  );
  if (index < 0) {
    throw new Error(`Could not find pi-ai cursor release ${cursorVersion}`);
  }
  return index === releases.length - 1 ? null : (releases.at(-1) ?? null);
}

export function extractChangelogRange(
  changelog: string,
  previousVersion: string,
  currentVersion: string,
): string {
  const currentHeading = new RegExp(
    `^## \\[${escapeRegExp(currentVersion)}\\].*$`,
    "m",
  ).exec(changelog);
  if (!currentHeading) {
    throw new Error(`Could not find pi-ai changelog section ${currentVersion}`);
  }
  const previousHeading = new RegExp(
    `^## \\[${escapeRegExp(previousVersion)}\\].*$`,
    "m",
  ).exec(changelog.slice(currentHeading.index + currentHeading[0].length));
  if (!previousHeading) {
    throw new Error(
      `Could not find pi-ai changelog section ${previousVersion}`,
    );
  }
  const end =
    currentHeading.index + currentHeading[0].length + previousHeading.index;
  return changelog.slice(currentHeading.index, end).trim();
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

function resolveReleaseSource(
  repoDir: string,
  tag: string,
  release: PackageRelease,
): { sourceCommit: string; tagCommit: string } {
  fetchTag(repoDir, tag);
  const tagCommit = git(["rev-list", "-n", "1", tag], repoDir).trim();
  const sourceCommit = release.git_head ?? tagCommit;
  if (sourceCommit !== tagCommit) {
    fetchCommit(repoDir, sourceCommit);
  }
  const packageJson = showFile(
    repoDir,
    sourceCommit,
    "packages/ai/package.json",
  );
  if (packageJson === null) {
    throw new Error(`packages/ai/package.json is missing at ${sourceCommit}`);
  }
  const sourceVersion = (JSON.parse(packageJson) as { version?: unknown })
    .version;
  if (sourceVersion !== release.version) {
    throw new Error(
      `pi-ai npm ${release.version} source ${sourceCommit} declares version ${String(sourceVersion)}`,
    );
  }
  return { sourceCommit, tagCommit };
}

function fetchCommit(repoDir: string, commit: string): void {
  git(["fetch", "--filter=blob:none", "origin", commit], repoDir);
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
