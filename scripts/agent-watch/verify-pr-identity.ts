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
      !pullRequest.isDraft,
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
      `Closed watcher PRs that did not match author=${options.expectedLogin} and draft=true: ${details}`,
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") repo = argv[++index] ?? "";
    else if (argument === "--marker") marker = argv[++index] ?? "";
    else if (argument === "--expected-login") {
      expectedLogin = argv[++index] ?? "";
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error("--repo is required");
  if (!marker) throw new Error("--marker is required");
  if (!expectedLogin) throw new Error("--expected-login is required");
  return { repo, marker, expectedLogin };
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pullRequests = JSON.parse(
    runGh([
      "pr",
      "list",
      "--repo",
      args.repo,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "author,body,isDraft,number,url",
    ]),
  ) as WatcherPullRequest[];
  const verified = enforceWatcherPrIdentity({
    ...args,
    pullRequests,
    closePullRequest: (pullRequest) => {
      runGh(["pr", "close", pullRequest.url, "--repo", args.repo]);
    },
  });
  console.log(
    verified
      ? `Verified Amelia draft PR: ${verified.url}`
      : `No open PR contains marker ${JSON.stringify(args.marker)}`,
  );
}

if (import.meta.main) main();
