import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export function ghJson<T>(args: string[]): T {
  return JSON.parse(runGh(args)) as T;
}

export function ensureLabel(repo: string, label: string): void {
  const result = spawnSync(
    "gh",
    [
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--description",
      "Automated Claude Code upstream monitoring",
      "--color",
      "7E57C2",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0 && !result.stderr.includes("already exists")) {
    throw new Error(`gh label create ${label} failed:\n${result.stderr}`);
  }
}

export function findIssueByExactTitle(
  repo: string,
  title: string,
): { number: number; url: string; body: string } | null {
  const issues = ghJson<Array<{ number: number; title: string; url: string }>>([
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
    "number,title,url",
  ]);
  const issue = issues.find((candidate) => candidate.title === title);
  if (!issue) return null;
  return { ...issue, body: getIssueBody(repo, issue.number) };
}

export function createIssue(
  repo: string,
  title: string,
  body: string,
  label: string,
): { number: number; url: string; body: string } {
  const bodyFile = writeTemp(body, "claude-watch-issue");
  try {
    const url = runGh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body-file",
      bodyFile,
      "--label",
      label,
    ]).trim();
    const issue = ghJson<{ number: number; url: string; body: string | null }>([
      "issue",
      "view",
      url,
      "--repo",
      repo,
      "--json",
      "number,url,body",
    ]);
    return { ...issue, body: issue.body ?? "" };
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

export function getIssueBody(repo: string, issue: number): string {
  return (
    ghJson<{ body: string | null }>([
      "issue",
      "view",
      String(issue),
      "--repo",
      repo,
      "--json",
      "body",
    ]).body ?? ""
  );
}

export function editIssueBody(repo: string, issue: number, body: string): void {
  const bodyFile = writeTemp(body, "claude-watch-tracker");
  try {
    runGh([
      "issue",
      "edit",
      String(issue),
      "--repo",
      repo,
      "--body-file",
      bodyFile,
    ]);
  } finally {
    rmSync(bodyFile, { force: true });
  }
}

function writeTemp(body: string, prefix: string): string {
  const path = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}.md`);
  writeFileSync(path, body);
  return path;
}
