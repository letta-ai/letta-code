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

import { createIssueWithBody, ensureLabels, ghJson } from "./github.ts";
import {
  analyzeCodexRelease,
  DEFAULT_TARGET_REPO,
  listStableReleases,
} from "./release-analysis.ts";
import { renderBody, renderTitle } from "./render-issue.ts";

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

function hasReportedTag(targetRepo: string, tag: string): boolean {
  const issues = ghJson<Array<{ title: string }>>([
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

function createIssue(
  repo: string,
  title: string,
  body: string,
  verdict: string,
): void {
  const labels = ["codex-watch", "automation"];
  if (
    verdict === "tool-schema update needed" ||
    verdict === "tool-surface review needed"
  ) {
    labels.push("priority/review");
  }
  if (verdict === "no-op") labels.push("informational");

  ensureLabels(repo, labels);
  console.log(createIssueWithBody(repo, title, body, labels));
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

  const alreadyReported = args.dryRun
    ? false
    : hasReportedTag(args.repo, current.tag_name);
  if (alreadyReported) {
    console.log(`Already reported ${current.tag_name}; nothing to do.`);
    return;
  }

  const analysis = await analyzeCodexRelease({
    sinceTag: args.sinceTag,
    currentTag: args.currentTag,
  });

  const title = renderTitle(analysis);
  const body = renderBody(analysis);

  if (args.dryRun) {
    console.log(`# ${title}\n\n${body}`);
  } else {
    createIssue(args.repo, title, body, analysis.verdict);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
