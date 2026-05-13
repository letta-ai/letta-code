#!/usr/bin/env bun
/**
 * Watches stable openai/codex releases for tool/schema changes that may affect
 * the letta-code harness.
 *
 * Usage:
 *   bun scripts/codex-watch/check-release.ts --dry-run
 *   bun scripts/codex-watch/check-release.ts --dry-run --since rust-v0.129.0
 *   bun scripts/codex-watch/check-release.ts --repo letta-ai/letta-code
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideVerdict,
  diffModelsJson,
  type ModelsDiff,
  type ModelsJson,
} from "./diff-models-json.ts";
import {
  type PathChangeSummary,
  renderBody,
  renderTitle,
} from "./render-issue.ts";

const CODEX_REPO = "openai/codex";
const DEFAULT_TARGET_REPO =
  process.env.GITHUB_REPOSITORY || "letta-ai/letta-code";
const WATCHED_PATHS = [
  "codex-rs/models-manager/models.json",
  "codex-rs/models-manager/prompt.md",
  "codex-rs/core/src/tools",
  "codex-rs/apply-patch",
];

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  body: string | null;
  published_at: string | null;
}

interface Args {
  dryRun: boolean;
  sinceTag: string | null;
  currentTag: string | null;
  repo: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    sinceTag: null,
    currentTag: null,
    repo: DEFAULT_TARGET_REPO,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--since") args.sinceTag = argv[++i] ?? null;
    else if (a === "--current") args.currentTag = argv[++i] ?? null;
    else if (a === "--repo") args.repo = argv[++i] ?? args.repo;
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: bun scripts/codex-watch/check-release.ts [--dry-run] [--since TAG] [--current TAG] [--repo OWNER/REPO]`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function gh<T>(args: string[], input?: string): T {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 50 * 1024 * 1024,
    stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout) as T;
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

function isStableRelease(release: Release): boolean {
  if (release.draft || release.prerelease) return false;
  return /^(rust-v|v)?\d+\.\d+\.\d+$/.test(release.tag_name);
}

async function listStableReleases(): Promise<Release[]> {
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

function findPreviousStable(
  stables: Release[],
  currentTag: string,
): Release | null {
  const idx = stables.findIndex((r) => r.tag_name === currentTag);
  if (idx <= 0) return null;
  return stables[idx - 1] ?? null;
}

function hasReportedTag(targetRepo: string, tag: string): boolean {
  const issues = gh<Array<{ title: string }>>([
    "issue",
    "list",
    "--repo",
    targetRepo,
    "--state",
    "all",
    "--search",
    `[codex-watch] openai/codex ${tag} in:title`,
    "--limit",
    "20",
    "--json",
    "title",
  ]);
  return issues.some((i) =>
    i.title.startsWith(`[codex-watch] openai/codex ${tag} `),
  );
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
  return out.split("\n").filter(Boolean).slice(0, 12);
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

function createIssue(
  repo: string,
  title: string,
  body: string,
  verdict: string,
): void {
  const labels = ["codex-watch", "automation"];
  if (verdict === "tool-schema update needed") labels.push("priority/review");
  if (verdict === "no-op") labels.push("informational");

  ensureLabels(repo, labels);

  const bodyFile = join(tmpdir(), `codex-watch-${Date.now()}.md`);
  writeFileSync(bodyFile, body);
  try {
    const args = [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ];
    for (const label of labels) args.push("--label", label);
    const res = spawnSync("gh", args, { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`gh ${args.join(" ")} failed:\n${res.stderr}`);
    }
    console.log(res.stdout.trim());
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

function ensureLabels(repo: string, labels: string[]): void {
  for (const label of labels) {
    const res = spawnSync("gh", ["label", "create", label, "--repo", repo], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.status !== 0 && !res.stderr.includes("already exists")) {
      throw new Error(`gh label create ${label} failed:\n${res.stderr}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stables = await listStableReleases();
  if (stables.length === 0) throw new Error("No stable Codex releases found");

  const current = args.currentTag
    ? stables.find((r) => r.tag_name === args.currentTag)
    : stables.at(-1);
  if (!current)
    throw new Error(`Could not find current release ${args.currentTag}`);

  const previous = args.sinceTag
    ? (stables.find((r) => r.tag_name === args.sinceTag) ??
      ({ tag_name: args.sinceTag } as Release))
    : findPreviousStable(stables, current.tag_name);
  if (!previous)
    throw new Error(
      `Could not find previous stable before ${current.tag_name}`,
    );

  const alreadyReported = args.dryRun
    ? false
    : hasReportedTag(args.repo, current.tag_name);
  if (alreadyReported) {
    console.log(`Already reported ${current.tag_name}; nothing to do.`);
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "codex-watch-"));
  try {
    const repoDir = cloneCodex(tmp);
    git(
      [
        "fetch",
        "--filter=blob:none",
        "origin",
        `refs/tags/${previous.tag_name}:refs/tags/${previous.tag_name}`,
      ],
      repoDir,
    );
    git(
      [
        "fetch",
        "--filter=blob:none",
        "origin",
        `refs/tags/${current.tag_name}:refs/tags/${current.tag_name}`,
      ],
      repoDir,
    );

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

    const workflowUrl =
      process.env.GITHUB_SERVER_URL &&
      process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "local dry-run";

    const input = {
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
      workflow_run_url: workflowUrl,
    };

    const title = renderTitle(input);
    const body = renderBody(input);

    if (args.dryRun) {
      console.log(`# ${title}\n\n${body}`);
    } else {
      createIssue(args.repo, title, body, verdict);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
