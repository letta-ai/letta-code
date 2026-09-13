import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PullRequestStatus {
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
}

export function runGh(args: string[], input?: string): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 50 * 1024 * 1024,
    stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

export function ghJson<T>(args: string[], input?: string): T {
  return JSON.parse(runGh(args, input)) as T;
}

export function ensureLabels(repo: string, labels: string[]): void {
  for (const label of labels) {
    const result = spawnSync("gh", ["label", "create", label, "--repo", repo], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 && !result.stderr.includes("already exists")) {
      throw new Error(`gh label create ${label} failed:\n${result.stderr}`);
    }
  }
}

export function createIssueWithBody(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): string {
  const bodyFile = writeTempMarkdown(body, "pi-ai-watch-issue");
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
    return runGh(args).trim();
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

export function editIssueBody(
  repo: string,
  issueNumber: number,
  body: string,
): void {
  const bodyFile = writeTempMarkdown(body, "pi-ai-watch-tracker");
  try {
    runGh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--body-file",
      bodyFile,
    ]);
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

export function getIssueBody(repo: string, issueNumber: number): string {
  const issue = ghJson<{ body: string | null }>([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "body",
  ]);
  return issue.body ?? "";
}

export function findIssueByExactTitle(
  repo: string,
  title: string,
): { number: number; title: string } | null {
  const issues = ghJson<Array<{ number: number; title: string }>>([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--search",
    `${title} in:title`,
    "--limit",
    "20",
    "--json",
    "number,title",
  ]);
  return issues.find((issue) => issue.title === title) ?? null;
}

export function getPullRequestStatus(prUrl: string): PullRequestStatus {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(
    prUrl,
  );
  if (!match) throw new Error(`Invalid GitHub pull request URL ${prUrl}`);
  const [, owner, repo, number] = match;
  const pull = ghJson<{ state: "OPEN" | "CLOSED"; mergedAt: string | null }>([
    "pr",
    "view",
    number as string,
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "state,mergedAt",
  ]);
  return {
    state: pull.mergedAt ? "MERGED" : pull.state,
    url: prUrl,
  };
}

function writeTempMarkdown(body: string, prefix: string): string {
  const path = join(tmpdir(), `${prefix}-${Date.now()}.md`);
  writeFileSync(path, body);
  return path;
}
