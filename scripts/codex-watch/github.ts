import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runGh(args: string[], input?: string): string {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 50 * 1024 * 1024,
    stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${res.stderr}`);
  }
  return res.stdout;
}

export function ghJson<T>(args: string[], input?: string): T {
  return JSON.parse(runGh(args, input)) as T;
}

export function ensureLabels(repo: string, labels: string[]): void {
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

export function createIssueWithBody(
  repo: string,
  title: string,
  body: string,
  labels: string[] = [],
): string {
  const bodyFile = writeTempMarkdown(body, "codex-watch-issue");
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
  const bodyFile = writeTempMarkdown(body, "codex-watch-tracker");
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
): { number: number; title: string; state: string } | null {
  const issues = ghJson<
    Array<{ number: number; title: string; state: string }>
  >([
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
    "number,title,state",
  ]);
  return issues.find((issue) => issue.title === title) ?? null;
}

function writeTempMarkdown(body: string, prefix: string): string {
  const bodyFile = join(tmpdir(), `${prefix}-${Date.now()}.md`);
  writeFileSync(bodyFile, body);
  return bodyFile;
}
