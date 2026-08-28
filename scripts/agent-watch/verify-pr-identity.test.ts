import { describe, expect, test } from "bun:test";
import {
  enforceWatcherPrIdentity,
  parseArgs,
  type WatcherPullRequest,
} from "./verify-pr-identity.ts";

const marker = "Pi-ai-watch: 1.0.0...1.0.1";

function pullRequest(
  overrides: Partial<WatcherPullRequest> = {},
): WatcherPullRequest {
  return {
    author: { login: "amelia-letta" },
    body: marker,
    isDraft: true,
    number: 123,
    url: "https://github.com/letta-ai/letta-code/pull/123",
    ...overrides,
  };
}

function enforce(
  pullRequests: WatcherPullRequest[],
  closed: string[] = [],
): WatcherPullRequest | null {
  return enforceWatcherPrIdentity({
    repo: "letta-ai/letta-code",
    marker,
    expectedLogin: "amelia-letta",
    pullRequests,
    closePullRequest: (candidate) => closed.push(candidate.url),
  });
}

describe("enforceWatcherPrIdentity", () => {
  test("returns the matching Amelia draft PR", () => {
    expect(enforce([pullRequest()])?.number).toBe(123);
  });

  test("ignores unrelated open PRs", () => {
    expect(enforce([pullRequest({ body: "unrelated" })])).toBeNull();
  });

  test("closes and rejects a PR from the wrong author", () => {
    const closed: string[] = [];
    expect(() =>
      enforce([pullRequest({ author: { login: "carenthomas" } })], closed),
    ).toThrow("author=carenthomas");
    expect(closed).toEqual(["https://github.com/letta-ai/letta-code/pull/123"]);
  });

  test("closes and rejects a ready PR", () => {
    const closed: string[] = [];
    expect(() => enforce([pullRequest({ isDraft: false })], closed)).toThrow(
      "draft=false",
    );
    expect(closed).toHaveLength(1);
  });

  test("rejects duplicate valid PRs", () => {
    expect(() =>
      enforce([
        pullRequest(),
        pullRequest({
          number: 124,
          url: "https://github.com/letta-ai/letta-code/pull/124",
        }),
      ]),
    ).toThrow("Multiple open watcher PRs");
  });
});

describe("parseArgs", () => {
  test("requires every identity input", () => {
    expect(() => parseArgs(["--repo", "letta-ai/letta-code"])).toThrow(
      "--marker is required",
    );
  });

  test("parses a complete invocation", () => {
    expect(
      parseArgs([
        "--repo",
        "letta-ai/letta-code",
        "--marker",
        marker,
        "--expected-login",
        "amelia-letta",
      ]),
    ).toEqual({
      repo: "letta-ai/letta-code",
      marker,
      expectedLogin: "amelia-letta",
    });
  });
});
