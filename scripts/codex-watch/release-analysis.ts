import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideVerdict,
  diffModelsJson,
  type ModelsDiff,
  type ModelsJson,
  type Verdict,
} from "./diff-models-json.ts";
import type { PathChangeSummary, RenderInput } from "./render-issue.ts";

export const CODEX_REPO = "openai/codex";
export const DEFAULT_TARGET_REPO =
  process.env.GITHUB_REPOSITORY || "letta-ai/letta-code";
export const WATCHED_PATHS = [
  "codex-rs/models-manager/models.json",
  "codex-rs/models-manager/prompt.md",
  "codex-rs/core/src/tools",
  "codex-rs/apply-patch",
];

const MAX_COMMITS_PER_PATH = 8;

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  body: string | null;
  published_at: string | null;
}

export interface AnalyzeCodexReleaseOptions {
  sinceTag: string | null;
  currentTag: string | null;
}

export interface CodexWatchAnalysis extends RenderInput {
  verdict: Verdict;
  models_diff: ModelsDiff | null;
  compare_url: string;
  changed_files: string[];
}

export async function analyzeCodexRelease(
  options: AnalyzeCodexReleaseOptions,
): Promise<CodexWatchAnalysis> {
  const stables = await listStableReleases();
  if (stables.length === 0) throw new Error("No stable Codex releases found");

  const current = options.currentTag
    ? stables.find((r) => r.tag_name === options.currentTag)
    : stables.at(-1);
  if (!current)
    throw new Error(`Could not find current release ${options.currentTag}`);

  const previous = options.sinceTag
    ? (stables.find((r) => r.tag_name === options.sinceTag) ??
      ({ tag_name: options.sinceTag } as Release))
    : findPreviousStable(stables, current.tag_name);
  if (!previous)
    throw new Error(
      `Could not find previous stable before ${current.tag_name}`,
    );

  const tmp = mkdtempSync(join(tmpdir(), "codex-watch-"));
  try {
    const repoDir = cloneCodex(tmp);
    fetchTag(repoDir, previous.tag_name);
    fetchTag(repoDir, current.tag_name);

    let modelsDiff: ModelsDiff | null = null;
    let parseError = false;
    try {
      const prevRaw = showFile(
        repoDir,
        previous.tag_name,
        "codex-rs/models-manager/models.json",
      );
      const currRaw = showFile(
        repoDir,
        current.tag_name,
        "codex-rs/models-manager/models.json",
      );
      if (!prevRaw || !currRaw)
        throw new Error("missing models.json at one tag");
      modelsDiff = diffModelsJson(
        JSON.parse(prevRaw) as ModelsJson,
        JSON.parse(currRaw) as ModelsJson,
      );
    } catch (err) {
      parseError = true;
      console.error(`Failed to parse/diff models.json: ${String(err)}`);
    }

    const changed = changedFiles(repoDir, previous.tag_name, current.tag_name);
    const changedSet = new Set(changed);
    const promptMdChanged = changedSet.has("codex-rs/models-manager/prompt.md");
    const toolsDirChanged = changed.some((f) =>
      f.startsWith("codex-rs/core/src/tools/"),
    );
    const applyPatchDirChanged = changed.some((f) =>
      f.startsWith("codex-rs/apply-patch/"),
    );
    const verdict = decideVerdict({
      models_diff: modelsDiff,
      prompt_md_changed: promptMdChanged,
      tools_dir_changed: toolsDirChanged,
      apply_patch_dir_changed: applyPatchDirChanged,
      parse_error: parseError,
    });

    const pathChanges: PathChangeSummary[] = WATCHED_PATHS.map((path) => ({
      path,
      commits: commitsForPath(
        repoDir,
        previous.tag_name,
        current.tag_name,
        path,
      ),
    })).filter((p) => p.commits.length > 0);

    return {
      previous_tag: previous.tag_name,
      current_tag: current.tag_name,
      release_url: current.html_url,
      release_notes_md: current.body ?? "",
      verdict,
      models_diff: modelsDiff,
      prompt_md_changed: promptMdChanged,
      prompt_md_diff_preview: promptMdChanged
        ? diffPreview(
            repoDir,
            previous.tag_name,
            current.tag_name,
            "codex-rs/models-manager/prompt.md",
          )
        : null,
      path_changes: pathChanges,
      workflow_run_url: workflowRunUrl(),
      compare_url: `https://github.com/${CODEX_REPO}/compare/${previous.tag_name}...${current.tag_name}`,
      changed_files: changed,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function listStableReleases(): Promise<Release[]> {
  const releases: Release[] = [];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/repos/${CODEX_REPO}/releases?per_page=100&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(
        `GitHub releases API failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as Release[];
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases
    .filter(isStableRelease)
    .sort((a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? ""));
}

function isStableRelease(release: Release): boolean {
  if (release.draft || release.prerelease) return false;
  return /^(rust-v|v)?\d+\.\d+\.\d+$/.test(release.tag_name);
}

function findPreviousStable(
  stables: Release[],
  currentTag: string,
): Release | null {
  const idx = stables.findIndex((r) => r.tag_name === currentTag);
  if (idx <= 0) return null;
  return stables[idx - 1] ?? null;
}

function cloneCodex(tmp: string): string {
  const dir = join(tmp, "codex");
  git([
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    `https://github.com/${CODEX_REPO}.git`,
    dir,
  ]);
  return dir;
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

function showFile(repoDir: string, tag: string, path: string): string | null {
  const res = spawnSync("git", ["show", `${tag}:${path}`], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return null;
  return res.stdout;
}

function changedFiles(
  repoDir: string,
  prevTag: string,
  currTag: string,
): string[] {
  return git(["diff", "--name-only", `${prevTag}..${currTag}`], repoDir)
    .split("\n")
    .filter(Boolean);
}

function commitsForPath(
  repoDir: string,
  prevTag: string,
  currTag: string,
  path: string,
): string[] {
  const out = git(
    ["log", "--format=%h %s", `${prevTag}..${currTag}`, "--", path],
    repoDir,
  );
  const commits = out.split("\n").filter(Boolean);
  if (commits.length <= MAX_COMMITS_PER_PATH) return commits;
  return [
    ...commits.slice(0, MAX_COMMITS_PER_PATH),
    `…and ${commits.length - MAX_COMMITS_PER_PATH} more commits`,
  ];
}

function diffPreview(
  repoDir: string,
  prevTag: string,
  currTag: string,
  path: string,
): string | null {
  const out = git(
    ["diff", "--unified=2", `${prevTag}..${currTag}`, "--", path],
    repoDir,
  );
  if (!out.trim()) return null;
  return out.split("\n").slice(0, 120).join("\n");
}

function git(args: string[], cwd?: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${res.stderr}`);
  }
  return res.stdout;
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
