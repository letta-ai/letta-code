import { describe, expect, test } from "bun:test";
import {
  enforceWatcherPrIdentity,
  findWatcherPullRequests,
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

function apiPullRequest(
  overrides: Partial<{
    body: string | null;
    draft: boolean;
    html_url: string;
    number: number;
    user: { login: string } | null;
  }> = {},
) {
  return {
    body: marker,
    draft: true,
    html_url: "https://github.com/letta-ai/letta-code/pull/123",
    number: 123,
    user: { login: "amelia-letta" },
    ...overrides,
  };
}

function enforce(
  pullRequests: WatcherPullRequest[],
  closed: string[] = [],
  pullRequestState: "draft" | "ready" = "draft",
): WatcherPullRequest | null {
  return enforceWatcherPrIdentity({
    repo: "letta-ai/letta-code",
    marker,
    expectedLogin: "amelia-letta",
    pullRequestState,
    pullRequests,
    closePullRequest: (candidate) => closed.push(candidate.url),
  });
}

describe("findWatcherPullRequests", () => {
  test("finds a marker PR omitted from every bounded search attempt", () => {
    const calls: string[][] = [];
    let waits = 0;
    const result = findWatcherPullRequests(
      { repo: "letta-ai/letta-code", marker },
      (args) => {
        calls.push(args);
        return args[0] === "pr" ? "[]" : JSON.stringify([[apiPullRequest()]]);
      },
      () => {
        waits += 1;
      },
    );

    expect(result.map((candidate) => candidate.number)).toEqual([123]);
    expect(calls.filter(([command]) => command === "pr")).toHaveLength(3);
    expect(calls.at(-1)?.slice(0, 6)).toEqual([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      "repos/letta-ai/letta-code/pulls",
    ]);
    expect(waits).toBe(2);
  });

  test("does not miss a duplicate omitted from server-side search", () => {
    const duplicate = apiPullRequest({
      html_url: "https://github.com/letta-ai/letta-code/pull/124",
      number: 124,
    });
    const result = findWatcherPullRequests(
      { repo: "letta-ai/letta-code", marker },
      (args) =>
        args[0] === "pr"
          ? JSON.stringify([pullRequest()])
          : JSON.stringify([[apiPullRequest(), duplicate]]),
      () => {},
    );

    expect(result.map((candidate) => candidate.number)).toEqual([123, 124]);
    expect(() => enforce(result)).toThrow("Multiple open watcher PRs");
  });

  test("proves persistent absence authoritatively and fails closed on API failure", () => {
    const absent = findWatcherPullRequests(
      { repo: "letta-ai/letta-code", marker },
      (args) => (args[0] === "pr" ? "[]" : "[[]]"),
      () => {},
    );
    expect(absent).toEqual([]);

    expect(() =>
      findWatcherPullRequests(
        { repo: "letta-ai/letta-code", marker },
        (args) => {
          if (args[0] === "pr") throw new Error("search unavailable");
          throw new Error("authoritative listing unavailable");
        },
        () => {},
      ),
    ).toThrow("authoritative listing unavailable");
  });

  test("checks every authoritative page beyond 1,000 open pull requests", () => {
    const pages = Array.from({ length: 10 }, (_, page) =>
      Array.from({ length: 100 }, (_, index) =>
        apiPullRequest({
          body: "unrelated",
          number: page * 100 + index + 1,
        }),
      ),
    );
    pages.push([apiPullRequest({ number: 1_001 })]);
    const result = findWatcherPullRequests(
      { repo: "letta-ai/letta-code", marker },
      (args) => (args[0] === "pr" ? "[]" : JSON.stringify(pages)),
      () => {},
    );

    expect(result.map((candidate) => candidate.number)).toEqual([1_001]);
  });

  test("rejects fuzzy authoritative candidates and keeps every exact match", () => {
    const result = findWatcherPullRequests(
      { repo: "letta-ai/letta-code", marker },
      (args) =>
        args[0] === "pr"
          ? JSON.stringify([pullRequest()])
          : JSON.stringify([
              [
                apiPullRequest({
                  body: "Pi ai watch 1.0.0 1.0.1",
                  number: 999,
                }),
                apiPullRequest(),
              ],
            ]),
      () => {},
    );

    expect(result.map((candidate) => candidate.number)).toEqual([123]);
  });

  test("passes shell metacharacters as one search argument", () => {
    const unsafeMarker = 'Watcher: $(touch /tmp/pwned); "quoted"';
    const calls: string[][] = [];
    findWatcherPullRequests(
      { repo: "letta-ai/letta-code", marker: unsafeMarker },
      (args) => {
        calls.push(args);
        return args[0] === "pr" ? "[]" : "[[]]";
      },
      () => {},
    );

    for (const command of calls.filter(([name]) => name === "pr")) {
      expect(command[command.indexOf("--search") + 1]).toBe(
        `${unsafeMarker} in:body`,
      );
    }
    expect(calls.at(-1)).toContain("state=open");
    expect(calls.at(-1)).toContain("per_page=100");
  });
});

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

  test("returns the matching Amelia ready PR when ready is required", () => {
    expect(
      enforce([pullRequest({ isDraft: false })], [], "ready")?.number,
    ).toBe(123);
  });

  test("closes and rejects a draft PR when ready is required", () => {
    const closed: string[] = [];
    expect(() => enforce([pullRequest()], closed, "ready")).toThrow(
      "state=ready",
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

  test("requires the expected pull request state", () => {
    expect(() =>
      parseArgs([
        "--repo",
        "letta-ai/letta-code",
        "--marker",
        marker,
        "--expected-login",
        "amelia-letta",
      ]),
    ).toThrow("--pull-request-state is required");
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
        "--pull-request-state",
        "draft",
      ]),
    ).toEqual({
      repo: "letta-ai/letta-code",
      marker,
      expectedLogin: "amelia-letta",
      pullRequestState: "draft",
    });
  });

  test("parses a ready pull request requirement", () => {
    expect(
      parseArgs([
        "--repo",
        "letta-ai/letta-cloud",
        "--marker",
        marker,
        "--expected-login",
        "amelia-letta",
        "--pull-request-state",
        "ready",
      ]),
    ).toEqual({
      repo: "letta-ai/letta-cloud",
      marker,
      expectedLogin: "amelia-letta",
      pullRequestState: "ready",
    });
  });
});
