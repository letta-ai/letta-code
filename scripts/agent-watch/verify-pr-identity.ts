#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

export interface WatcherPullRequest {
  author: { login: string } | null;
  body: string | null;
  isDraft: boolean;
  number: number;
  url: string;
}

interface Args {
  expectedLogin: string;
  marker: string;
  pullRequestState: "draft" | "ready";
  repo: string;
}

interface EnforceOptions extends Args {
  closePullRequest: (pullRequest: WatcherPullRequest) => void;
  pullRequests: WatcherPullRequest[];
}

export function enforceWatcherPrIdentity(
  options: EnforceOptions,
): WatcherPullRequest | null {
  const matches = options.pullRequests.filter((pullRequest) =>
    pullRequest.body?.includes(options.marker),
  );
  const invalid = matches.filter(
    (pullRequest) =>
      pullRequest.author?.login !== options.expectedLogin ||
      pullRequest.isDraft !== (options.pullRequestState === "draft"),
  );

  for (const pullRequest of invalid) options.closePullRequest(pullRequest);

  if (invalid.length > 0) {
    const details = invalid
      .map(
        (pullRequest) =>
          `${pullRequest.url} (author=${pullRequest.author?.login ?? "unknown"}, draft=${pullRequest.isDraft})`,
      )
      .join(", ");
    throw new Error(
      `Closed watcher PRs that did not match author=${options.expectedLogin} and state=${options.pullRequestState}: ${details}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple open watcher PRs contain marker ${JSON.stringify(options.marker)}`,
    );
  }
  return matches[0] ?? null;
}

export function parseArgs(argv: string[]): Args {
  let repo = "";
  let marker = "";
  let expectedLogin = "";
  let pullRequestState: "draft" | "ready" | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") repo = argv[++index] ?? "";
    else if (argument === "--marker") marker = argv[++index] ?? "";
    else if (argument === "--expected-login") {
      expectedLogin = argv[++index] ?? "";
    } else if (argument === "--pull-request-state") {
      const state = argv[++index];
      if (state !== "draft" && state !== "ready") {
        throw new Error("--pull-request-state must be draft or ready");
      }
      pullRequestState = state;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error("--repo is required");
  if (!marker) throw new Error("--marker is required");
  if (!expectedLogin) throw new Error("--expected-login is required");
  if (!pullRequestState) throw new Error("--pull-request-state is required");
  return { repo, marker, expectedLogin, pullRequestState };
}

function runGh(args: string[]): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

interface GitHubPullRequest {
  body: string | null;
  draft: boolean;
  html_url: string;
  number: number;
  user: { login: string } | null;
}

const SEARCH_ATTEMPTS = 3;

export function findWatcherPullRequests(
  args: Pick<Args, "repo" | "marker">,
  executeGh: (command: string[]) => string = runGh,
  waitForSearchIndex: () => void = () => Bun.sleepSync(1_000),
): WatcherPullRequest[] {
  for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt += 1) {
    let foundExactHint = false;
    try {
      const candidates = JSON.parse(
        executeGh([
          "pr",
          "list",
          "--repo",
          args.repo,
          "--state",
          "open",
          "--search",
          `${args.marker} in:body`,
          "--limit",
          "1000",
          "--json",
          "author,body,isDraft,number,url",
        ]),
      ) as WatcherPullRequest[];
      foundExactHint = candidates.some((pullRequest) =>
        pullRequest.body?.includes(args.marker),
      );
    } catch {
      // Search is only an acceleration hint. The authoritative list below must
      // still prove presence, absence, and uniqueness.
    }
    if (foundExactHint) break;
    if (attempt + 1 < SEARCH_ATTEMPTS) waitForSearchIndex();
  }

  const pages = JSON.parse(
    executeGh([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      `repos/${args.repo}/pulls`,
      "-f",
      "state=open",
      "-f",
      "per_page=100",
    ]),
  ) as GitHubPullRequest[][];
  return pages
    .flatMap((page) => page)
    .filter((pullRequest) => pullRequest.body?.includes(args.marker))
    .map((pullRequest) => ({
      author: pullRequest.user,
      body: pullRequest.body,
      isDraft: pullRequest.draft,
      number: pullRequest.number,
      url: pullRequest.html_url,
    }));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pullRequests = findWatcherPullRequests(args);
  const verified = enforceWatcherPrIdentity({
    ...args,
    pullRequests,
    closePullRequest: (pullRequest) => {
      runGh(["pr", "close", pullRequest.url, "--repo", args.repo]);
    },
  });
  console.log(
    verified
      ? `Verified Amelia ${args.pullRequestState} PR: ${verified.url}`
      : `No open PR contains marker ${JSON.stringify(args.marker)}`,
  );
}

if (import.meta.main) main();
